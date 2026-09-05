/**
 * @license GPL-3.0-or-later
 * Copyright (C) 2025 Caleb Gyamfi - Omnixys Technologies
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * For more information, visit <https://www.gnu.org/licenses/>.
 */

import { Injectable } from '@nestjs/common';

import { InvitationWriteService } from '../invitation/service/invitation-write.service.js';
import { AddGuestIdToInvitationDTO } from '@omnixys/contracts-ts';
import {
  IKafkaEventContext,
  KafkaEvent,
  KafkaEventHandler,
  KafkaTopics,
} from '@omnixys/kafka-ts';
import { OmnixysLogger, type ScopedLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';

/**
 * Kafka event handler responsible for useristrative commands such as
 * shutdown and restart. It listens for specific user-related topics
 * and delegates the actual process control logic to the {@link UserService}.
 *
 * @category Messaging
 * @since 1.0.0
 */
@KafkaEventHandler('ticket')
@Injectable()
export class TicketHandler {
  private readonly logger: ScopedLogger;

  /**
   * Creates a new instance of {@link UserHandler}.
   *
   * @param loggerService - The central logger service used for structured logging.
   * @param userService - The service responsible for handling system-level user operations.
   */
  constructor(
    loggerService: OmnixysLogger,
    private readonly invitationWriteService: InvitationWriteService,
  ) {
    this.logger = loggerService.log(
      'service:invitation',
      this.constructor.name,
    );
  }

  @KafkaEvent(KafkaTopics.invitation.addGuestId)
  async handleAddGuestId(
    payload: AddGuestIdToInvitationDTO,
    _context: IKafkaEventContext,
  ): Promise<void> {
    this.logger.debug(
      'Kafka message received: topic=%s | invitationId=%s | guestId=%s',
      KafkaTopics.invitation.addGuestId,
      payload.invitationId,
      payload.userId,
    );

    return TraceRunner.run('[HANDLER] addGuestId', async () => {
      this.logger.debug(
        'Kafka processing started: topic=%s | invitationId=%s | guestId=%s',
        KafkaTopics.invitation.addGuestId,
        payload.invitationId,
        payload.userId,
      );

      try {
        await this.invitationWriteService.addGuestId(payload);
        this.logger.debug(
          'Kafka processing completed: topic=%s | invitationId=%s | guestId=%s',
          KafkaTopics.invitation.addGuestId,
          payload.invitationId,
          payload.userId,
        );
      } catch (error: unknown) {
        this.logger.error(
          'Kafka processing failed: topic=%s | invitationId=%s | guestId=%s | error=%o',
          KafkaTopics.invitation.addGuestId,
          payload.invitationId,
          payload.userId,
          error,
        );
        throw error;
      }
    });
  }
}
