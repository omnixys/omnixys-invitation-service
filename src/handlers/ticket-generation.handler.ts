import { GuestConfirmationService } from '../invitation/service/guest-confirmation.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Injectable } from '@nestjs/common';
import {
  DelayedJob,
  DelayedJobHandler,
  DelayedJobKeys,
  ValkeyLockService,
} from '@omnixys/cache-ts';
import { OmnixysLogger } from '@omnixys/logger-ts';

@Injectable()
@DelayedJobHandler()
export class TicketGenerationHandler {
  private readonly logger;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: ValkeyLockService,
    private readonly guestConfirmation: GuestConfirmationService,
    logger: OmnixysLogger,
  ) {
    this.logger = logger.log(this.constructor.name, 'service:invitation');
  }

  @DelayedJob(DelayedJobKeys.ticket.generate)
  async generateTicket(payload: {
    invitationId: string;
    eventId: string;
    seatId: string | null;
    actorId: string;
  }): Promise<void> {
    const { invitationId, seatId, actorId } = payload;

    const lockKey = `lock:ticket-generate:${invitationId}`;
    const token = await this.lock.acquireLock(lockKey, 60000);

    if (!token) {
      this.logger.debug('Lock already held for ticket generation: %o', {
        invitationId,
      });
      return;
    }

    try {
      const invitation = await this.prisma.invitation.findUnique({
        where: { id: invitationId },
        select: {
          status: true,
          guestProfileId: true,
          pendingContactId: true,
          firstName: true,
          lastName: true,
          eventName: true,
          eventEndsAt: true,
        },
      });

      if (!invitation) {
        this.logger.warn(
          'Invitation not found for delayed ticket generation: %o',
          {
            invitationId,
          },
        );
        return;
      }

      if (invitation.status !== 'APPROVED') {
        this.logger.debug(
          'Invitation no longer approved – skipping ticket generation: %o',
          {
            invitationId,
            status: invitation.status,
          },
        );
        return;
      }

      if (invitation.guestProfileId) {
        this.logger.debug(
          'Guest profile already exists – ticket was already generated: %o',
          {
            invitationId,
          },
        );
        return;
      }

      if (!invitation.pendingContactId) {
        this.logger.warn(
          'Pending contact missing for delayed ticket generation: %o',
          { invitationId },
        );
        return;
      }

      if (!invitation.firstName || !invitation.lastName) {
        this.logger.warn(
          'Guest name incomplete for delayed ticket generation: %o',
          { invitationId },
        );
        return;
      }

      this.logger.info('Delayed ticket generation firing: %o', {
        invitationId,
      });

      await this.guestConfirmation.sendFirstConfirmation({
        invitationId,
        seatId,
        actorId,
      });

      this.logger.info('Delayed ticket generation completed: %o', {
        invitationId,
      });
    } finally {
      await this.lock.releaseLock(lockKey, token);
    }
  }
}
