import { AnalyticsOutboxService } from '../../analytics/analytics-outbox.service.js';
import { env } from '../../config/env.js';
import {
  Invitation,
  InvitationStatus,
  InvitationType,
  PhoneNumber,
  Prisma,
  PhoneNumberType as PrismaPhoneNumberType,
  RsvpChoice,
} from '../../prisma/generated/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  InvitationAccessDeniedException,
  InvitationNotFoundException,
  InvitationValidationException,
  MissingContactMethodException,
  MissingRsvpContactDetailsException,
  RsvpAlreadyAcceptedException,
} from '../errors/invitation-domain.error.js';
import { RsvpDomain } from '../models/domain/rsvp.domain.js';
import { CreatePlusOneInput } from '../models/input/plus-one.input.js';
import { PublicRsvpInput } from '../models/input/public-rsvp.input.js';
import { RSVPInput } from '../models/input/rsvp.input.js';
import { UpdatePlusOneInput } from '../models/input/update-plus-one.input.js';
import { InvitationMapper } from '../models/mappers/invitation.mapper.js';
import { InvitationPayload } from '../models/payloads/invitation.payload.js';
import { shouldAutoApproveInvitation, shouldAutoApprovePlusOnes } from '../utils/approval-mode.js';
import { AdminWriteService } from './invitation-admin.write.service.js';
import { InvitationBaseService } from './invitation-base.service.js';
import { Injectable } from '@nestjs/common';
import { ValkeyKey, ValkeyService } from '@omnixys/cache-ts';
import { ContextAccessor, type ClientContext } from '@omnixys/context-ts';
import {
  getPrimaryPhoneNumber,
  n2u,
  PhoneNumberType as SharedPhoneNumberType,
  type CreatePendingUserDTO,
  type EventMilestoneRecordedDTO,
  type InvitationSeatingInfoUpdatedDTO,
  type PhoneNumberDTO,
} from '@omnixys/contracts-ts';
import { KafkaProducerService, KafkaTopics } from '@omnixys/kafka-ts';
import { OmnixysLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';
import { createHash } from 'node:crypto';

const { DEFAULT_TENANT_ID } = env;

/**
 * Deterministic UUIDv7 for temporary/unauthenticated actor identity.
 * Used as sentinel in unauthenticated guest flows until real U is provisioned.
 * Not a real user identity — downstream services must treat nil UUID as "no actor".
 */
function tempActorId(namespace: string, key: string): string {
  const bytes = createHash('sha1').update(`${namespace}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // Version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 Variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type InvitationWithPhones = Prisma.InvitationGetPayload<{
  include: { phoneNumbers: true };
}>;

/**
 * Maps Prisma enum → Shared enum
 */
export function mapPhoneNumberType(type: PrismaPhoneNumberType): SharedPhoneNumberType {
  return type as unknown as SharedPhoneNumberType;
}

function mapPhoneNumber(ph: PhoneNumber): PhoneNumberDTO {
  return {
    number: ph.number,
    type: mapPhoneNumberType(ph.type),
    label: ph.label ?? undefined,
    isPrimary: ph.isPrimary,
    countryCode: ph.countryCode,
  };
}

function hasValidPhoneNumber(phoneNumbers?: Array<{ number?: string | null }> | null): boolean {
  return phoneNumbers?.some((phoneNumber) => (phoneNumber.number ?? '').trim().length > 0) ?? false;
}

function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ?? null;
}

function currentTenantId(): string {
  const context = ContextAccessor.get();
  return context?.tenant?.tenantId ?? context?.principal?.tenantId ?? DEFAULT_TENANT_ID;
}

@Injectable()
export class GuestWriteService extends InvitationBaseService {
  constructor(
    prisma: PrismaService,
    logger: OmnixysLogger,
    private readonly cache: ValkeyService,
    private readonly producer: KafkaProducerService,
    private readonly adminWrite: AdminWriteService,
    private readonly analyticsOutbox: AnalyticsOutboxService,
  ) {
    super(logger, prisma);
  }

  /**
   * RSVP reply for an existing invitation.
   *
   * Business rules:
   * - PlusOnes ONLY exist when RSVP = YES
   * - For MAYBE / NO → no plusOnes must be processed
   */
  async reply(input: RSVPInput, clientInfo: ClientContext): Promise<InvitationPayload> {
    return TraceRunner.run('[SERVICE] reply', async () => {
      const { invitationId: id, choice, replyInput } = input;

      this.logger.debug(`reply: id=${id} choice=${choice}`);

      const invitation = await this.ensureExists(id);
      const settings = await this.prismaService.eventSettingsProjection.findUnique({
        where: { eventId: invitation.eventId },
        select: { approvalMode: true },
      });
      const autoApproveOnAccept =
        invitation.autoApproveOnAccept ||
        shouldAutoApproveInvitation(settings?.approvalMode, invitation.type);

      /**
       * Prevent double RSVP
       */
      if (invitation.rsvpChoice === RsvpChoice.YES || invitation.rsvpChoice === RsvpChoice.NO) {
        throw new RsvpAlreadyAcceptedException(id);
      }

      const now = new Date();
      const previous = invitation.rsvpChoice ?? null;

      const decision = RsvpDomain.decide(previous, choice, !!replyInput);
      const resultingStatus =
        invitation.status === InvitationStatus.APPROVAL_STAGED &&
        decision.newChoice === RsvpChoice.YES
          ? InvitationStatus.APPROVAL_STAGED
          : decision.newStatus;

      /**
       * Validate contact details for YES
       */
      if (decision.newChoice === RsvpChoice.YES) {
        if (!replyInput) {
          throw new MissingRsvpContactDetailsException();
        }

        if (!hasValidPhoneNumber(replyInput.phoneNumbers)) {
          throw new MissingContactMethodException();
        }
      }

      const selectedInvitedBy = replyInput?.selectedInvitedBy;

      const inputPlusOnes = replyInput?.plusOnes ?? [];
      let createdPlusOnes: InvitationWithPhones[] = [];

      const maxInvitees = invitation.maxInvitees ?? 0;
      /**
       * Enforce maxInvitees limit (hard cap)
       */
      const allowedPlusOnes =
        decision.newChoice === RsvpChoice.YES ? inputPlusOnes.slice(0, maxInvitees) : [];

      /**
       * Validate plusOnes
       */
      if (decision.newChoice === RsvpChoice.YES) {
        for (const p of allowedPlusOnes) {
          if (!p.firstName || !p.lastName) {
            throw new InvitationValidationException('Plus-one firstName and lastName are required');
          }

          if (!p.plusOneAgeCategory) {
            throw new InvitationValidationException('Plus-one age category is required');
          }
        }
      }

      /**
       * 🔥 TRANSACTION (CRITICAL)
       */
      this.logger.debug('RSVP transaction started: invitationId=%s', id);

      const result = await this.prismaService.$transaction(async (tx) => {
        /**
         * 1. Update parent invitation
         */
        const updatedInvitation = await tx.invitation.update({
          where: { id },
          data: {
            rsvpChoice: decision.newChoice,
            status: resultingStatus,
            rsvpAt: now,
            firstName: replyInput?.firstName ?? invitation.firstName,
            lastName: replyInput?.lastName ?? invitation.lastName,
            phoneNumber: getPrimaryPhoneNumber(replyInput?.phoneNumbers) ?? invitation.phoneNumber,
            email: replyInput?.email ?? invitation.email,
            guestNote: normalizeOptionalText(replyInput?.guestNote),
            selectedInvitedBy: selectedInvitedBy ?? invitation.selectedInvitedBy,
          },
        });

        /**
         * 2. Create plusOnes ONLY if YES
         */
        if (decision.newChoice === RsvpChoice.YES && inputPlusOnes.length > 0) {
          for (const p of allowedPlusOnes) {
            const created = await tx.invitation.create({
              data: {
                type: InvitationType.PRIVATE,
                eventId: invitation.eventId,
                firstName: p.firstName,
                lastName: p.lastName,
                email: p.email ?? null,

                status: InvitationStatus.ACCEPTED,
                rsvpChoice: RsvpChoice.YES,
                rsvpAt: now,

                invitedByInvitationId: invitation.id,
                plusOneAgeCategory: p.plusOneAgeCategory,
                phoneNumber: getPrimaryPhoneNumber(p?.phoneNumbers),
                selectedInvitedBy: selectedInvitedBy ?? invitation.selectedInvitedBy,

                /**
                 * Nested phone numbers
                 */
                phoneNumbers: p.phoneNumbers?.length
                  ? {
                      createMany: {
                        data: p.phoneNumbers.map((ph) => ({
                          number: ph.number,
                          type: ph.type,
                          label: ph.label ?? null,
                          isPrimary: ph.isPrimary ?? false,
                          countryCode: ph.countryCode,
                        })),
                      },
                    }
                  : undefined,
              },
              include: {
                phoneNumbers: true,
              },
            });

            createdPlusOnes = [...createdPlusOnes, created];
          }
        }

        /**
         * 3. Build pending contact (optional flow)
         */
        let pendingContactId: string | undefined;

        if (decision.needsContactDetails) {
          if (!replyInput) {
            throw new MissingRsvpContactDetailsException();
          }

          const pendingUser: CreatePendingUserDTO = {
            firstName: replyInput.firstName ?? invitation.firstName,
            lastName: replyInput.lastName ?? invitation.lastName,
            invitationId: invitation.id,
            email: n2u(replyInput.email ?? null),
            phoneNumbers: replyInput.phoneNumbers,
            guestNote: normalizeOptionalText(replyInput.guestNote) ?? undefined,
            eventId: invitation.eventId,
            eventEndsAt: invitation.eventEndsAt ?? new Date(),
            tenantId: currentTenantId(),
            locale: clientInfo.locale,
            actorId: tempActorId('guest-rsvp', invitation.id),

            /**
             * Now mapped from DB-created plusOnes
             */
            plusOnes: createdPlusOnes.map((p) => ({
              invitationId: p.id,
              firstName: p.firstName,
              lastName: p.lastName,
              email: n2u(p.email),
              phoneNumbers: p.phoneNumbers.map(mapPhoneNumber),
              plusOneAgeCategory: n2u(p.plusOneAgeCategory),
            })),
          };

          pendingContactId = await this.cache.set(
            ValkeyKey.pendingContact,
            JSON.stringify(pendingUser),
            60 * 60 * 24,
          );

          /**
           * Attach pendingContactId AFTER creation
           */
          await tx.invitation.update({
            where: { id },
            data: {
              pendingContactId,
              pendingContactPayload: pendingUser as unknown as Prisma.InputJsonValue,
            },
          });
        }

        const isUpdate = previous !== null;
        await this.analyticsOutbox.enqueue(
          tx,
          isUpdate ? 'invitation.rsvp.updated.v1' : 'invitation.rsvp.submitted.v1',
          {
            eventName: isUpdate ? 'RsvpUpdated' : 'RsvpSubmitted',
            aggregateId: updatedInvitation.id,
            aggregateType: 'invitation',
            subjectId: updatedInvitation.guestProfileId ?? undefined,
            properties: {
              choice: decision.newChoice,
              eventId: updatedInvitation.eventId,
              plusOneCount: createdPlusOnes.length,
            },
          },
        );
        if (decision.newChoice === RsvpChoice.YES || decision.newChoice === RsvpChoice.NO) {
          const accepted = decision.newChoice === RsvpChoice.YES;
          await this.analyticsOutbox.enqueue(
            tx,
            accepted ? 'invitation.accepted.v1' : 'invitation.declined.v1',
            {
              eventName: accepted ? 'InvitationAccepted' : 'InvitationDeclined',
              aggregateId: updatedInvitation.id,
              aggregateType: 'invitation',
              subjectId: updatedInvitation.guestProfileId ?? undefined,
              properties: {
                eventId: updatedInvitation.eventId,
                isPlusOne: Boolean(updatedInvitation.invitedByInvitationId),
              },
            },
          );
        }

        return updatedInvitation;
      });

      this.logger.debug(
        'RSVP transaction completed: invitationId=%s | choice=%s',
        id,
        decision.newChoice,
      );

      const truncated = inputPlusOnes.length > maxInvitees;

      if (inputPlusOnes.length > maxInvitees) {
        this.logger.warn(
          `PlusOnes truncated: invitation=${id} requested=${inputPlusOnes.length} allowed=${maxInvitees}`,
        );
      }

      await this.publishSeatingInfoUpdated({
        eventId: invitation.eventId,
        invitationId: id,
        guestId: result.guestProfileId ?? '',
        selectedInvitedBy: selectedInvitedBy ?? invitation.selectedInvitedBy,
      });

      for (const plusOne of createdPlusOnes) {
        await this.publishSeatingInfoUpdated({
          eventId: invitation.eventId,
          invitationId: plusOne.id,
          guestId: plusOne.guestProfileId ?? '',
          selectedInvitedBy: selectedInvitedBy ?? invitation.selectedInvitedBy,
        });
      }

      if (
        decision.newChoice === RsvpChoice.YES &&
        autoApproveOnAccept &&
        invitation.status !== InvitationStatus.APPROVAL_STAGED
      ) {
        const approvingActor = invitation.invitedByUserId;
        if (!approvingActor) {
          throw new InvitationValidationException('Automatic approval configuration is incomplete');
        }
        const approved = await this.adminWrite.approve({
          id,
          approve: true,
          actorId: approvingActor,
          activeEventId: invitation.eventId,
        });
        return { ...approved, plusOnesTruncated: truncated };
      }

      return {
        ...InvitationMapper.toPayload(result),
        plusOnesTruncated: truncated,
      };
    });
  }

  /**
   * Creates a plus-one invitation.
   */
  async createPlusOne({
    input,
    actorId,
    clientInfo,
  }: {
    input: CreatePlusOneInput;
    actorId: string;
    clientInfo: ClientContext;
  }): Promise<InvitationPayload> {
    return TraceRunner.run('[SERVICE] createPlusOne', async () => {
      const {
        eventId,
        invitedByInvitationId,
        firstName,
        lastName,
        email,
        phoneNumbers,
        plusOneAgeCategory,
      } = input;

      this.logger.debug(
        'createPlusOne: eventId=%s | invitationId=%s | actorId=%s',
        eventId,
        invitedByInvitationId,
        actorId,
      );

      if (!eventId || !invitedByInvitationId) {
        throw new InvitationValidationException('Required invitation fields are missing');
      }

      if (!firstName || !lastName) {
        throw new InvitationValidationException('Plus-one firstName and lastName are required');
      }

      if (!plusOneAgeCategory) {
        throw new InvitationValidationException('Plus-one age category is required');
      }

      /**
       * Optional: validate phoneNumbers
       */
      if (phoneNumbers?.length) {
        for (const ph of phoneNumbers) {
          if (!ph.number || !ph.countryCode || !ph.type) {
            throw new InvitationValidationException('Phone number is invalid');
          }
        }
      }

      this.logger.debug('Creating Plus One: invitationId=%s', invitedByInvitationId);

      const { payload: result, autoApprove } = await this.prismaService.$transaction(async (tx) => {
        const parent = await tx.invitation.findUnique({
          where: { id: invitedByInvitationId },
        });

        if (!parent) {
          throw new InvitationNotFoundException(invitedByInvitationId);
        }

        if (parent.eventId !== eventId) {
          throw new InvitationValidationException('Invitation event does not match', {
            eventId,
            parentEventId: parent.eventId,
          });
        }

        await this.ensureUserCanManageParentInvitation(tx, invitedByInvitationId, actorId);

        const updated = await tx.invitation.updateMany({
          where: {
            id: invitedByInvitationId,
            eventId,
            maxInvitees: { gt: 0 },
          },
          data: { maxInvitees: { decrement: 1 } },
        });

        if (updated.count !== 1) {
          throw new InvitationValidationException('No plus-one capacity remains', {
            invitationId: invitedByInvitationId,
          });
        }

        const settings = await tx.eventSettingsProjection.findUnique({
          where: { eventId },
          select: { requireApprovalForPlusOnes: true },
        });
        const now = new Date();
        const autoApprove =
          parent.status === InvitationStatus.APPROVED &&
          shouldAutoApprovePlusOnes(settings?.requireApprovalForPlusOnes);

        const child = await tx.invitation.create({
          data: {
            type: InvitationType.PRIVATE,
            eventId,
            invitedByInvitationId,
            invitedByUserId: actorId,

            firstName,
            lastName,
            email: email ?? null,
            plusOneAgeCategory,

            status: autoApprove ? InvitationStatus.ACCEPTED : InvitationStatus.PENDING,
            rsvpChoice: autoApprove ? RsvpChoice.YES : undefined,
            rsvpAt: autoApprove ? now : undefined,
            maxInvitees: 0,
            phoneNumber: getPrimaryPhoneNumber(phoneNumbers),
            phoneNumbers: phoneNumbers?.length
              ? {
                  createMany: {
                    data: phoneNumbers.map((ph) => ({
                      number: ph.number,
                      type: ph.type,
                      label: ph.label ?? null,
                      isPrimary: ph.isPrimary ?? false,
                      countryCode: ph.countryCode,
                    })),
                  },
                }
              : undefined,
          },
        });

        const pendingUser: CreatePendingUserDTO = {
          firstName,
          lastName,
          invitationId: child.id,
          email: email ?? undefined,
          phoneNumbers,
          plusOneAgeCategory,
          eventId,
          eventEndsAt: parent.eventEndsAt ?? new Date(),
          tenantId: currentTenantId(),
          locale: clientInfo.locale,
          actorId,
        };

        const pendingContactId = await this.cache.set(
          ValkeyKey.pendingContact,
          JSON.stringify(pendingUser),
          60 * 60 * 24,
        );

        const updatedChild = await tx.invitation.update({
          where: { id: child.id },
          data: {
            pendingContactId,
            pendingContactPayload: pendingUser as unknown as Prisma.InputJsonValue,
          },
        });
        await this.analyticsOutbox.enqueue(tx, 'invitation.created.v1', {
          eventName: 'InvitationCreated',
          aggregateId: updatedChild.id,
          aggregateType: 'invitation',
          subjectId: actorId,
          properties: {
            eventId: updatedChild.eventId,
            invitationType: updatedChild.type,
            isPlusOne: true,
          },
        });

        return {
          payload: InvitationMapper.toPayload(updatedChild),
          autoApprove,
        };
      });

      this.logger.debug(
        'Plus One created: invitationId=%s | parentInvitationId=%s',
        result.id,
        invitedByInvitationId,
      );

      await this.publishInvitationCreated(result);

      if (autoApprove) {
        return this.adminWrite.approve({
          id: result.id,
          approve: true,
          actorId,
          activeEventId: eventId,
        });
      }

      return result;
    });
  }

  /**
   * Updates a plus-one invitation.
   *
   * This operation:
   * - validates the target invitation
   * - ensures the target is really a plus-one
   * - ensures the authenticated user may manage the parent invitation
   * - fully replaces phone numbers for deterministic updates
   */
  async updatePlusOne(input: UpdatePlusOneInput, userId: string): Promise<InvitationPayload> {
    return TraceRunner.run('[SERVICE] updatePlusOne', async () => {
      const { id, firstName, lastName, email, phoneNumbers, plusOneAgeCategory } = input;

      this.logger.debug('updatePlusOne: invitationId=%s | actorId=%s', id, userId);

      if (!id) {
        throw new InvitationValidationException('Plus-one invitation ID is required');
      }

      if (!firstName || !lastName) {
        throw new InvitationValidationException('Plus-one firstName and lastName are required');
      }

      if (!plusOneAgeCategory) {
        throw new InvitationValidationException('Plus-one age category is required');
      }

      if (phoneNumbers?.length) {
        for (const phoneNumber of phoneNumbers) {
          if (!phoneNumber.number || !phoneNumber.countryCode || !phoneNumber.type) {
            throw new InvitationValidationException('Phone number is invalid');
          }
        }
      }

      this.logger.debug('Updating Plus One: invitationId=%s', id);

      const result = await this.prismaService.$transaction(async (tx) => {
        const existing = await tx.invitation.findUnique({
          where: {
            id,
          },
          include: {
            phoneNumbers: true,
          },
        });

        if (!existing) {
          throw new InvitationNotFoundException(id);
        }

        this.ensureIsPlusOne(existing);

        const parentInvitationId = existing.invitedByInvitationId;
        if (!parentInvitationId) {
          throw new InvitationValidationException(
            'Plus-one parent invitation reference is missing',
            { invitationId: id },
          );
        }

        await this.ensureUserCanManageParentInvitation(tx, parentInvitationId, userId);

        await tx.phoneNumber.deleteMany({
          where: {
            invitationId: existing.id,
          },
        });

        const updated = await tx.invitation.update({
          where: {
            id: existing.id,
          },
          data: {
            firstName,
            lastName,
            email: email ?? null,
            plusOneAgeCategory,
            phoneNumber: getPrimaryPhoneNumber(phoneNumbers) ?? null,
            phoneNumbers: phoneNumbers?.length
              ? {
                  createMany: {
                    data: phoneNumbers.map((phoneNumber) => ({
                      number: phoneNumber.number,
                      type: phoneNumber.type,
                      label: phoneNumber.label ?? null,
                      isPrimary: phoneNumber.isPrimary ?? false,
                      countryCode: phoneNumber.countryCode,
                    })),
                  },
                }
              : undefined,
          },
        });

        return InvitationMapper.toPayload(updated);
      });

      this.logger.debug('Plus One updated: invitationId=%s | actorId=%s', id, userId);

      return result;
    });
  }

  /**
   * Deletes a plus-one invitation.
   */
  async deletePlusOne(id: string, actorId: string): Promise<InvitationPayload> {
    return TraceRunner.run('[SERVICE] deletePlusOne', async () => {
      this.logger.debug('removing Plus One %s | actorId=%s', id, actorId);
      const result = await this.prismaService.$transaction(async (tx) => {
        const child = await tx.invitation.findUnique({
          where: { id },
        });

        if (!child) {
          throw new InvitationNotFoundException(id);
        }

        this.ensureIsPlusOne(child);

        const parentInvitationId = child.invitedByInvitationId;
        if (!parentInvitationId) {
          throw new InvitationValidationException(
            'Plus-one parent invitation reference is missing',
            { invitationId: id },
          );
        }

        await this.ensureUserCanManageParentInvitation(tx, parentInvitationId, actorId);

        const guestId = child.guestProfileId;
        if (child.pendingContactId) {
          await this.cache.delete(ValkeyKey.pendingContact, child.pendingContactId);
        }

        const deleted = await tx.invitation.delete({ where: { id } });

        await tx.invitation.update({
          where: { id: parentInvitationId },
          data: {
            maxInvitees: { increment: 1 },
          },
        });

        if (guestId) {
          this.logger.debug(
            'Sending Kafka event: topic=%s | invitationId=%s | guestId=%s',
            KafkaTopics.authentication.deleteGuest,
            id,
            guestId,
          );

          await this.producer.send({
            topic: KafkaTopics.authentication.deleteGuest,
            payload: {
              userId: guestId,
            },
            meta: {
              service: 'invitation-service',
              operation: 'Send confirm guest notification',
              version: '1',
              type: 'EVENT',
              actorId,
              tenantId: currentTenantId(),
            },
          });

          this.logger.debug(
            'Kafka event sent: topic=%s | invitationId=%s | guestId=%s',
            KafkaTopics.authentication.deleteGuest,
            id,
            guestId,
          );
        } else {
          this.logger.debug('Guest profile not found – skip Kafka event: invitationId=%s', id);
        }

        return InvitationMapper.toPayload(deleted);
      });

      this.logger.debug('Plus One deleted: invitationId=%s | actorId=%s', id, actorId);

      return result;
    });
  }

  /**
   * Public RSVP → creates invitation + plusOnes + pending user
   */
  async createFromPublicRsvp(
    input: PublicRsvpInput,
    clientInfo: ClientContext,
  ): Promise<InvitationPayload> {
    return TraceRunner.run('[SERVICE] createFromPublicRsvp', async () => {
      this.logger.debug(
        'createFromPublicRsvp: eventId=%s | plusOnes=%s',
        input.eventId,
        input.plusOnes?.length ?? 0,
      );

      if (!hasValidPhoneNumber(input.phoneNumbers)) {
        throw new MissingContactMethodException();
      }

      for (const plusOne of input.plusOnes ?? []) {
        if (!plusOne.firstName || !plusOne.lastName) {
          throw new InvitationValidationException('Plus-one firstName and lastName are required');
        }

        if (!plusOne.plusOneAgeCategory) {
          throw new InvitationValidationException('Plus-one age category is required');
        }
      }

      const guestNote =
        normalizeOptionalText(input.guestNote) ?? normalizeOptionalText(input.message);
      const selectedInvitedBy =
        input.selectedInvitedBy
          ?.map((value) => value.trim())
          .filter((value, index, all) => value && all.indexOf(value) === index) ?? [];

      const settings = await this.prismaService.eventSettingsProjection.findUnique({
        where: { eventId: input.eventId },
      });

      const { invitee, plusOneInvitations } = await this.prismaService.$transaction(async (tx) => {
        const invitee = await tx.invitation.create({
          data: {
            type: InvitationType.PUBLIC,
            eventId: input.eventId,
            eventName: settings?.name ?? null,
            eventEndsAt: settings?.endsAt ?? null,
            autoApproveOnAccept: shouldAutoApproveInvitation(
              settings?.approvalMode,
              InvitationType.PUBLIC,
            ),
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.email,
            status: InvitationStatus.ACCEPTED,
            rsvpChoice: RsvpChoice.YES,
            rsvpAt: new Date(),
            maxInvitees: input.plusOnes?.length ?? 0,
            selectedInvitedBy,
            guestNote,
            phoneNumber: getPrimaryPhoneNumber(input.phoneNumbers),
            phoneNumbers: input.phoneNumbers?.length
              ? {
                  createMany: {
                    data: input.phoneNumbers.map((ph) => ({
                      number: ph.number,
                      type: ph.type,
                      label: ph.label ?? null,
                      isPrimary: ph.isPrimary ?? false,
                      countryCode: ph.countryCode,
                    })),
                  },
                }
              : undefined,
          },
        });

        const plusOneInvitations: InvitationWithPhones[] = [];
        for (const plusOne of input.plusOnes ?? []) {
          if (!plusOne.firstName || !plusOne.lastName) {
            continue;
          }
          const created = await tx.invitation.create({
            data: {
              type: InvitationType.PUBLIC,
              eventId: input.eventId,
              firstName: plusOne.firstName,
              lastName: plusOne.lastName,
              status: InvitationStatus.ACCEPTED,
              rsvpChoice: RsvpChoice.YES,
              rsvpAt: new Date(),
              invitedByInvitationId: invitee.id,
              email: plusOne.email,
              plusOneAgeCategory: plusOne.plusOneAgeCategory,
              selectedInvitedBy,
              phoneNumber: getPrimaryPhoneNumber(plusOne.phoneNumbers),
              phoneNumbers: plusOne.phoneNumbers?.length
                ? {
                    createMany: {
                      data: plusOne.phoneNumbers.map((phone) => ({
                        number: phone.number,
                        type: phone.type,
                        label: phone.label ?? null,
                        isPrimary: phone.isPrimary ?? false,
                        countryCode: phone.countryCode,
                      })),
                    },
                  }
                : undefined,
            },
            include: { phoneNumbers: true },
          });
          plusOneInvitations.push(created);
          await this.analyticsOutbox.enqueue(tx, 'invitation.created.v1', {
            eventName: 'InvitationCreated',
            aggregateId: created.id,
            aggregateType: 'invitation',
            properties: {
              eventId: created.eventId,
              invitationType: created.type,
              isPlusOne: true,
            },
          });
          await this.analyticsOutbox.enqueue(tx, 'invitation.accepted.v1', {
            eventName: 'InvitationAccepted',
            aggregateId: created.id,
            aggregateType: 'invitation',
            properties: {
              eventId: created.eventId,
              isPlusOne: true,
            },
          });
        }

        await this.analyticsOutbox.enqueue(tx, 'invitation.created.v1', {
          eventName: 'InvitationCreated',
          aggregateId: invitee.id,
          aggregateType: 'invitation',
          properties: {
            eventId: invitee.eventId,
            invitationType: invitee.type,
            isPlusOne: false,
          },
        });
        await this.analyticsOutbox.enqueue(tx, 'invitation.rsvp.submitted.v1', {
          eventName: 'RsvpSubmitted',
          aggregateId: invitee.id,
          aggregateType: 'invitation',
          properties: {
            choice: RsvpChoice.YES,
            eventId: invitee.eventId,
            plusOneCount: plusOneInvitations.length,
          },
        });
        await this.analyticsOutbox.enqueue(tx, 'invitation.accepted.v1', {
          eventName: 'InvitationAccepted',
          aggregateId: invitee.id,
          aggregateType: 'invitation',
          properties: {
            eventId: invitee.eventId,
            isPlusOne: false,
          },
        });
        return { invitee, plusOneInvitations };
      });

      this.logger.debug(
        'Public RSVP invitation created: invitationId=%s | eventId=%s',
        invitee.id,
        input.eventId,
      );

      this.logger.debug(
        'Public RSVP Plus Ones created: invitationId=%s | count=%s',
        invitee.id,
        plusOneInvitations.length,
      );

      /**
       * 3. Build pending user (deterministic!)
       */
      const pendingUser: CreatePendingUserDTO = {
        firstName: input.firstName,
        lastName: input.lastName,
        invitationId: invitee.id,
        email: n2u(input.email ?? null),
        phoneNumbers: input.phoneNumbers,
        selectedInvitedBy,
        guestNote: guestNote ?? undefined,
        eventId: input.eventId,
        eventEndsAt: invitee.eventEndsAt ?? new Date(),
        tenantId: currentTenantId(),
        locale: clientInfo.locale,
        actorId: tempActorId('guest-plusone', invitee.id),

        plusOnes: plusOneInvitations.map((p) => ({
          invitationId: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          email: n2u(p.email),
          plusOneAgeCategory: n2u(p.plusOneAgeCategory),
          phoneNumbers: p.phoneNumbers.map((ph) => ({
            type: ph.type as SharedPhoneNumberType,
            countryCode: ph.countryCode,
            number: ph.number,
            label: n2u(ph.label),
            isPrimary: n2u(ph.isPrimary),
          })),
        })),
      };

      const pendingContactId = await this.cache.set(
        ValkeyKey.pendingContact,
        JSON.stringify(pendingUser),
        60 * 60 * 24 * 7,
      );

      const updated = await this.prismaService.invitation.update({
        where: { id: invitee.id },
        data: {
          pendingContactId,
          pendingContactPayload: pendingUser as unknown as Prisma.InputJsonValue,
        },
      });

      this.logger.debug(
        'Public RSVP completed: invitationId=%s | eventId=%s',
        invitee.id,
        input.eventId,
      );

      await this.publishInvitationCreated(InvitationMapper.toPayload(updated));

      await this.publishSeatingInfoUpdated({
        eventId: input.eventId,
        invitationId: invitee.id,
        guestId: updated.guestProfileId ?? '',
        selectedInvitedBy,
      });

      for (const plusOne of plusOneInvitations) {
        await this.publishSeatingInfoUpdated({
          eventId: input.eventId,
          invitationId: plusOne.id,
          guestId: plusOne.guestProfileId ?? '',
          selectedInvitedBy,
        });
      }

      if (updated.autoApproveOnAccept) {
        return this.adminWrite.approve({
          id: updated.id,
          approve: true,
          actorId: tempActorId('system-auto-approval', updated.id),
          activeEventId: input.eventId,
        });
      }

      return InvitationMapper.toPayload(updated);
    });
  }

  async deleteAllPlusOnes(parentId: string, actorId: string): Promise<InvitationPayload[]> {
    return TraceRunner.run('[SERVICE] deleteAllPlusOnes', async () => {
      this.logger.debug('deleteAllPlusOnes: invitationId=%s | actorId=%s', parentId, actorId);

      const result = await this.prismaService.$transaction(async (tx) => {
        const parent = await tx.invitation.findUnique({
          where: { id: parentId },
          select: { id: true, eventId: true, plusOnes: true },
        });

        if (!parent) {
          throw new InvitationNotFoundException(parentId);
        }

        await this.ensureUserCanManageParentInvitation(tx, parentId, actorId);

        const children = await tx.invitation.findMany({
          where: { invitedByInvitationId: parentId, eventId: parent.eventId },
          select: { id: true, pendingContactId: true, guestProfileId: true },
        });

        const fullChildren = [];
        const plusOneIds = [];

        for (const c of children) {
          if (c.pendingContactId) {
            await this.cache.delete(ValkeyKey.pendingContact, c.pendingContactId);
          }

          if (c.guestProfileId) {
            plusOneIds.push(c.guestProfileId);
          }

          const deleted = await tx.invitation.delete({ where: { id: c.id } });
          fullChildren.push(InvitationMapper.toPayload(deleted));
        }

        await tx.invitation.update({
          where: { id: parentId },
          data: {
            maxInvitees: { increment: children.length },
            // plusOnes: { set: [] },
          },
        });

        if (plusOneIds.length > 0) {
          this.logger.debug(
            'Sending Kafka event: topic=%s | invitationId=%s | count=%s',
            KafkaTopics.authentication.deleteGuestList,
            parentId,
            plusOneIds.length,
          );

          await this.producer.send({
            topic: KafkaTopics.authentication.deleteGuestList,
            payload: {
              userIds: plusOneIds,
            },
            meta: {
              service: 'invitation-service',
              operation: 'Delete Guest Accounts',
              version: '1',
              type: 'EVENT',
              actorId,
              tenantId: currentTenantId(),
            },
          });

          this.logger.debug(
            'Kafka event sent: topic=%s | invitationId=%s | count=%s',
            KafkaTopics.authentication.deleteGuestList,
            parentId,
            plusOneIds.length,
          );
        } else {
          this.logger.debug(
            'Guest profiles not found – skip Kafka event: invitationId=%s',
            parentId,
          );
        }

        return fullChildren;
      });

      this.logger.debug(
        'All Plus Ones deleted: invitationId=%s | count=%s',
        parentId,
        result.length,
      );

      return result;
    });
  }

  private ensureIsPlusOne(child: Invitation): void {
    if (!child.invitedByInvitationId) {
      throw new InvitationValidationException('Invitation is not a plus-one', {
        invitationId: child.id,
      });
    }
  }

  private async publishInvitationCreated(invitation: InvitationPayload): Promise<void> {
    const context = ContextAccessor.get();
    const payload: EventMilestoneRecordedDTO = {
      eventId: invitation.eventId,
      milestoneId: `${invitation.id}:created`,
      type: 'INVITATION_CREATED',
      label: 'Invitation created',
      occurredAt: invitation.createdAt.toISOString(),
      referenceId: invitation.id,
    };
    await this.producer.send({
      topic: KafkaTopics.event.milestoneRecorded,
      payload,
      meta: {
        service: 'invitation-service',
        operation: 'Record Event Milestone',
        version: '1',
        type: 'EVENT',
        actorId: context?.principal?.actorId ?? '',
        tenantId: currentTenantId(),
      },
    });
  }

  private async publishSeatingInfoUpdated(dto: InvitationSeatingInfoUpdatedDTO): Promise<void> {
    const context = ContextAccessor.get();
    await this.producer.send({
      topic: KafkaTopics.invitation.seatingInfoUpdated,
      payload: dto,
      meta: {
        service: 'invitation-service',
        operation: 'Invitation Seating Info Updated',
        version: '1',
        type: 'EVENT',
        actorId: context?.principal?.actorId ?? '',
        tenantId: currentTenantId(),
      },
    });
  }

  /**
   * Ensures the authenticated user may manage the parent invitation.
   *
   * Rule:
   * - the parent invitation must belong to the current guestProfileId
   * - alternatively, the parent invitation may have been created by the same user
   */
  private async ensureUserCanManageParentInvitation(
    tx: Prisma.TransactionClient,
    parentInvitationId: string,
    userId?: string,
  ): Promise<void> {
    if (!userId) {
      throw new InvitationAccessDeniedException(parentInvitationId, 'authentication-required');
    }

    const parent = await tx.invitation.findUnique({
      where: {
        id: parentInvitationId,
      },
      select: {
        id: true,
        guestProfileId: true,
        invitedByUserId: true,
      },
    });

    if (!parent) {
      throw new InvitationNotFoundException(parentInvitationId);
    }

    const isOwner = parent.guestProfileId === userId;
    const isCreator = parent.invitedByUserId === userId;

    if (!isOwner && !isCreator) {
      throw new InvitationAccessDeniedException(
        parentInvitationId,
        'plus-one-management-forbidden',
      );
    }
  }
}
