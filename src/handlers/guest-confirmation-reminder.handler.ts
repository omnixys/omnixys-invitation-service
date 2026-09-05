import { env } from '../config/env.js';
import { GuestConfirmationService } from '../invitation/service/guest-confirmation.service.js';
import { InvitationStatus } from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Injectable } from '@nestjs/common';
import {
  DelayedJob,
  DelayedJobHandler,
  DelayedJobKeys,
  ValkeyLockService,
} from '@omnixys/cache-ts';
import { OmnixysLogger } from '@omnixys/logger-ts';

const GUEST_REMINDER_OFFSETS: Record<string, number> = {
  WEEK_BEFORE: 7 * 24 * 60 * 60 * 1000,
  THREE_DAYS_BEFORE: 3 * 24 * 60 * 60 * 1000,
  HOURS_24_BEFORE: 24 * 60 * 60 * 1000,
};

/**
 * Scheduled reminder for guests who did not complete their registration within
 * the confirmation link lifetime. Re-checks every guard under a per-invitation
 * lock before delegating to the shared resend flow.
 */
@Injectable()
@DelayedJobHandler()
export class GuestConfirmationReminderHandler {
  private readonly logger;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: ValkeyLockService,
    private readonly guestConfirmation: GuestConfirmationService,
    logger: OmnixysLogger,
  ) {
    this.logger = logger.log(this.constructor.name, 'service:invitation');
  }

  @DelayedJob(DelayedJobKeys.guest.confirmation.remind)
  async remind(payload: {
    invitationId: string;
    actorId?: string;
    preset?: string;
  }): Promise<void> {
    const { invitationId, actorId, preset } = payload;
    const lockKey = `lock:guest-confirmation:${invitationId}`;
    const lockToken = await this.lock.acquireLock(lockKey, 60000);

    if (!lockToken) {
      this.logger.debug('Lock already held for confirmation reminder: %o', {
        invitationId,
      });
      return;
    }

    try {
      const invitation = await this.prisma.invitation.findUnique({
        where: { id: invitationId },
        select: {
          eventId: true,
          guestProfileId: true,
          status: true,
          confirmationResendCount: true,
          eventEndsAt: true,
          pendingContactPayload: true,
        },
      });

      if (!invitation) {
        this.logger.warn('Invitation not found for confirmation reminder: %o', {
          invitationId,
        });
        return;
      }

      const settings = await this.prisma.eventSettingsProjection.findUnique({
        where: { eventId: invitation.eventId },
        select: {
          startsAt: true,
          guestConfirmationReminderEnabled: true,
          guestConfirmationReminderPresets: true,
          guestConfirmationMaxResends: true,
        },
      });

      if (settings && !settings.guestConfirmationReminderEnabled) {
        this.logger.debug(
          'Confirmation reminder skipped, reminders disabled in settings: %o',
          { invitationId },
        );
        return;
      }

      if (settings?.startsAt && preset) {
        const offset = GUEST_REMINDER_OFFSETS[preset];
        if (
          offset !== undefined &&
          Date.now() < settings.startsAt.getTime() - offset
        ) {
          this.logger.debug('Confirmation reminder too early, skipping: %o', {
            invitationId,
            preset,
          });
          return;
        }
      }

      if (invitation.guestProfileId) {
        this.logger.debug(
          'Confirmation reminder skipped, guest already registered: %o',
          { invitationId },
        );
        return;
      }

      if (
        invitation.status !== InvitationStatus.APPROVED &&
        invitation.status !== InvitationStatus.ACCEPTED
      ) {
        this.logger.debug(
          'Confirmation reminder skipped, invitation not actionable: %o',
          { invitationId, status: invitation.status },
        );
        return;
      }

      if (
        invitation.eventEndsAt &&
        invitation.eventEndsAt.getTime() <= Date.now()
      ) {
        this.logger.debug(
          'Confirmation reminder skipped, event already ended: %o',
          {
            invitationId,
          },
        );
        return;
      }

      const maxResends =
        settings?.guestConfirmationMaxResends ?? env.GUEST_REMINDER_MAX_RESENDS;

      if ((invitation.confirmationResendCount ?? 0) >= maxResends) {
        this.logger.warn(
          'Confirmation reminder skipped, max resends reached: %o',
          {
            invitationId,
            resendCount: invitation.confirmationResendCount,
            maxResends,
          },
        );
        return;
      }

      if (!invitation.pendingContactPayload) {
        this.logger.warn(
          'Confirmation reminder skipped, pending payload missing: %o',
          { invitationId },
        );
        return;
      }

      const result = await this.guestConfirmation.resendConfirmation({
        invitationId,
        actorId,
      });

      this.logger.info(
        'Confirmation reminder fired: invitationId=%s resent=%s reason=%s',
        invitationId,
        result.resent,
        result.reason ?? 'n/a',
      );
    } finally {
      await this.lock.releaseLock(lockKey, lockToken);
    }
  }
}
