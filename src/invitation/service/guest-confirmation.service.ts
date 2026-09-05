import { AnalyticsOutboxService } from '../../analytics/analytics-outbox.service.js';
import { env } from '../../config/env.js';
import { Invitation, InvitationStatus, Prisma } from '../../prisma/generated/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { InvitationNotFoundException } from '../errors/invitation-domain.error.js';
import { Injectable } from '@nestjs/common';
import { DelayedJobKeys, DelayedJobService, ValkeyKey, ValkeyService } from '@omnixys/cache-ts';
import { ContextAccessor } from '@omnixys/context-ts';
import type { CreatePendingUserDTO, GuestNotificationDTO } from '@omnixys/contracts-ts';
import { KafkaProducerService, KafkaTopics } from '@omnixys/kafka-ts';
import { OmnixysLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';

const { DEFAULT_TENANT_ID } = env;

const PENDING_CONTACT_TTL_SECONDS = 60 * 60 * 24 * 7;

const GUEST_REMINDER_OFFSETS: Record<string, number> = {
  WEEK_BEFORE: 7 * 24 * 60 * 60 * 1000,
  THREE_DAYS_BEFORE: 3 * 24 * 60 * 60 * 1000,
  HOURS_24_BEFORE: 24 * 60 * 60 * 1000,
};

export interface ResendConfirmationResult {
  resent: boolean;
  reason?: string;
}

function currentTenantId(): string {
  const context = ContextAccessor.get();
  return context?.tenant?.tenantId ?? context?.principal?.tenantId ?? DEFAULT_TENANT_ID;
}

/**
 * Re-triggers the guest sign-up confirmation flow.
 *
 * The guest confirmation (email or WhatsApp) is delivered by the notification
 * service when it consumes `notification.confirmGuest`. Because the notification
 * service deletes the `pendingContact` cache entry after the first send, a resend
 * must re-anchor the pending user payload under a fresh token and emit the event
 * again so a new verification link is generated.
 */
@Injectable()
export class GuestConfirmationService {
  private readonly logger;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly cache: ValkeyService,
    private readonly producer: KafkaProducerService,
    private readonly delayedJob: DelayedJobService,
    private readonly analyticsOutbox: AnalyticsOutboxService,
    logger: OmnixysLogger,
  ) {
    this.logger = logger.log(this.constructor.name, 'service:invitation');
  }

  /**
   * Sends the first guest confirmation for an approved invitation (immediate
   * approve path and delayed ticket-generation path). Re-anchors the pending
   * payload so delayed releases never outlive the cache entry created during
   * sign-up.
   */
  async sendFirstConfirmation(input: {
    invitationId: string;
    seatId?: string | null;
    actorId?: string;
  }): Promise<boolean> {
    return TraceRunner.run('[SERVICE] sendFirstConfirmation', async () => {
      const { invitationId, seatId, actorId } = input;
      const invitation = await this.prismaService.invitation.findUnique({
        where: { id: invitationId },
        include: { phoneNumbers: true },
      });

      if (!invitation) {
        this.logger.warn('Invitation not found for confirmation send: %s', invitationId);
        return false;
      }

      if (invitation.guestProfileId) {
        this.logger.debug(
          'Confirmation skipped, guest already registered: invitationId=%s',
          invitationId,
        );
        return false;
      }

      if (
        invitation.status !== InvitationStatus.APPROVED &&
        invitation.status !== InvitationStatus.ACCEPTED
      ) {
        this.logger.debug(
          'Confirmation skipped, invitation not actionable: invitationId=%s status=%s',
          invitationId,
          invitation.status,
        );
        return false;
      }

      if (!invitation.pendingContactId) {
        this.logger.warn(
          'Confirmation skipped, pending contact missing: invitationId=%s',
          invitationId,
        );
        return false;
      }

      const payload = await this.resolvePendingContactPayload(invitation);
      if (!payload) {
        this.logger.warn(
          'Confirmation skipped, pending payload could not be resolved: invitationId=%s',
          invitationId,
        );
        return false;
      }

      const token = await this.reanchorPendingContact(payload);
      await this.persistSend(invitationId, token, payload, false);

      await this.emitConfirmGuest({
        invitation,
        token,
        seatId: seatId ?? undefined,
        actorId,
        operation: 'Send confirm guest notification',
      });

      await this.scheduleReminders(invitationId, actorId);
      return true;
    });
  }

  /**
   * Re-sends the guest confirmation for an invitation whose guest did not
   * complete the registration within the previous link lifetime.
   */
  async resendConfirmation(input: {
    invitationId: string;
    actorId?: string;
  }): Promise<ResendConfirmationResult> {
    return TraceRunner.run('[SERVICE] resendConfirmation', async () => {
      const { invitationId, actorId } = input;
      const invitation = await this.prismaService.invitation.findUnique({
        where: { id: invitationId },
        include: { phoneNumbers: true },
      });

      if (!invitation) {
        throw new InvitationNotFoundException(invitationId);
      }

      if (invitation.guestProfileId) {
        return { resent: false, reason: 'already-registered' };
      }

      if (
        invitation.status !== InvitationStatus.APPROVED &&
        invitation.status !== InvitationStatus.ACCEPTED
      ) {
        return { resent: false, reason: 'invalid-status' };
      }

      if (invitation.eventEndsAt && invitation.eventEndsAt.getTime() <= Date.now()) {
        return { resent: false, reason: 'event-ended' };
      }

      const payload = invitation.pendingContactPayload as unknown as CreatePendingUserDTO | null;
      if (!payload) {
        this.logger.warn(
          'Confirmation resend skipped, pending payload missing: invitationId=%s',
          invitationId,
        );
        return { resent: false, reason: 'missing-payload' };
      }

      const rateKey = `confirmation:resend:${invitationId}`;
      const inCooldown = await this.cache.rawGet(rateKey);
      if (inCooldown) {
        this.logger.debug(
          'Confirmation resend skipped, cooldown active: invitationId=%s',
          invitationId,
        );
        return { resent: false, reason: 'rate-limited' };
      }

      const cooldownSeconds = Math.ceil(env.GUEST_CONFIRMATION_RESEND_COOLDOWN_MS / 1000);
      await this.cache.rawSet(rateKey, '1', cooldownSeconds);

      const token = await this.reanchorPendingContact(payload);
      await this.persistSend(invitationId, token, payload, true);

      await this.emitConfirmGuest({
        invitation,
        token,
        seatId: undefined,
        actorId,
        operation: 'Resend confirm guest notification',
      });

      await this.recordResentAnalytics(invitationId);

      this.logger.info(
        'Confirmation resent: invitationId=%s actorId=%s',
        invitationId,
        actorId ?? 'system',
      );
      return { resent: true };
    });
  }

  private async resolvePendingContactPayload(
    invitation: Invitation,
  ): Promise<CreatePendingUserDTO | null> {
    const stored = invitation.pendingContactPayload as unknown as CreatePendingUserDTO | null;
    if (stored && typeof stored === 'object') {
      return stored;
    }

    if (!invitation.pendingContactId) {
      return null;
    }

    const raw = await this.cache.get(ValkeyKey.pendingContact, invitation.pendingContactId);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as CreatePendingUserDTO;
    } catch (error: unknown) {
      this.logger.warn(
        'Stored pending contact payload is corrupted: invitationId=%s error=%s',
        invitation.id,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  private async reanchorPendingContact(payload: CreatePendingUserDTO): Promise<string> {
    return this.cache.set(
      ValkeyKey.pendingContact,
      JSON.stringify(payload),
      PENDING_CONTACT_TTL_SECONDS,
    );
  }

  private async persistSend(
    invitationId: string,
    token: string,
    payload: CreatePendingUserDTO,
    incrementResend: boolean,
  ): Promise<void> {
    await this.prismaService.invitation.update({
      where: { id: invitationId },
      data: {
        pendingContactId: token,
        pendingContactPayload: payload as unknown as Prisma.InputJsonValue,
        confirmationSentAt: new Date(),
        ...(incrementResend ? { confirmationResendCount: { increment: 1 } } : {}),
      },
    });
  }

  private async emitConfirmGuest(input: {
    invitation: Invitation;
    token: string;
    seatId?: string;
    actorId?: string;
    operation: string;
  }): Promise<void> {
    const { invitation, token, seatId, actorId, operation } = input;
    const payload: GuestNotificationDTO = {
      token,
      eventName: invitation.eventName ?? '',
      seatId,
      eventEndsAt: invitation.eventEndsAt ?? new Date(),
    };

    await this.producer.send({
      topic: KafkaTopics.notification.confirmGuest,
      payload,
      meta: {
        service: 'invitation-service',
        operation,
        version: '1',
        type: 'EVENT',
        actorId,
        tenantId: currentTenantId(),
      },
    });

    this.logger.debug(
      'Kafka event sent: topic=%s | invitationId=%s | actorId=%s',
      KafkaTopics.notification.confirmGuest,
      invitation.id,
      actorId ?? 'system',
    );
  }

  private async scheduleReminders(invitationId: string, actorId?: string): Promise<void> {
    const invitation = await this.prismaService.invitation.findUnique({
      where: { id: invitationId },
      select: { eventId: true },
    });

    const settings = invitation
      ? await this.prismaService.eventSettingsProjection.findUnique({
          where: { eventId: invitation.eventId },
        })
      : null;

    const presets = settings?.guestConfirmationReminderPresets ?? [];

    if (
      settings &&
      settings.guestConfirmationReminderEnabled &&
      settings.startsAt &&
      presets.length > 0
    ) {
      const startsAtMs = settings.startsAt.getTime();
      const now = Date.now();
      const scheduled: Array<{ preset: string; delayMs: number }> = [];

      for (const preset of presets) {
        const offset = GUEST_REMINDER_OFFSETS[preset];
        if (!offset) {
          continue;
        }
        const delayMs = startsAtMs - offset - now;
        if (delayMs > 0) {
          scheduled.push({ preset, delayMs });
        }
      }

      if (scheduled.length === 0) {
        return;
      }

      for (const { preset, delayMs } of scheduled) {
        await this.delayedJob.schedule({
          type: DelayedJobKeys.guest.confirmation.remind,
          payload: { invitationId, actorId, preset },
          delayMs,
        });
      }

      this.logger.debug(
        'Confirmation reminders scheduled from settings: invitationId=%s count=%d',
        invitationId,
        scheduled.length,
      );
      return;
    }

    if (env.GUEST_REMINDER_AFTER_MS <= 0) {
      return;
    }

    await this.delayedJob.schedule({
      type: DelayedJobKeys.guest.confirmation.remind,
      payload: { invitationId, actorId },
      delayMs: env.GUEST_REMINDER_AFTER_MS,
    });

    this.logger.debug(
      'Confirmation reminder scheduled via fallback: invitationId=%s delayMs=%d',
      invitationId,
      env.GUEST_REMINDER_AFTER_MS,
    );
  }

  private async recordResentAnalytics(invitationId: string): Promise<void> {
    await this.prismaService.$transaction((tx) =>
      this.analyticsOutbox.enqueue(tx, 'guest.confirmation.resent.v1', {
        eventName: 'GuestConfirmationResent',
        aggregateId: invitationId,
        aggregateType: 'invitation',
        properties: {},
      }),
    );
  }
}
