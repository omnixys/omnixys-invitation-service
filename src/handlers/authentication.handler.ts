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

import { InvitationWriteService } from '../invitation/service/invitation-write.service.js';
import { Injectable } from '@nestjs/common';
import { UserIdDTO } from '@omnixys/contracts-ts';
import {
  IKafkaEventContext,
  KAFKA_HEADERS,
  KafkaEvent,
  KafkaEventHandler,
  KafkaTopics,
} from '@omnixys/kafka-ts';
import { OmnixysLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';

/**
 * Central Kafka Authentication Handler.
 *
 * Design principles:
 * - One class per domain (authentication)
 * - One method per Kafka topic
 * - Strict typing per method
 * - No switch/case
 * - No casting
 */
@KafkaEventHandler('authentication')
@Injectable()
export class AuthenticationHandler {
  private readonly logger;

  /**
   * Creates a new instance of {@link EventHandler}.
   *
   * @param loggerService - The central logger service used for structured logging.
   * @param userService - The service responsible for handling system-level user operations.
   */
  constructor(
    private readonly omnixysLogger: OmnixysLogger,
    private readonly invitationWriteService: InvitationWriteService,
  ) {
    this.logger = this.omnixysLogger.log(
      'service:invitation',
      this.constructor.name,
    );
  }

  @KafkaEvent(KafkaTopics.invitation.deleteUserInvitations)
  async handleDeleteInvitation(
    payload: UserIdDTO,
    context: IKafkaEventContext,
  ): Promise<void> {
    this.logger.debug(
      'Kafka message received: topic=%s | guestId=%s',
      KafkaTopics.invitation.deleteUserInvitations,
      payload.userId,
    );

    return TraceRunner.run('[HANDLER] Delete Invitation', async () => {
      const headers = context.headers;
      const actorId = headers[KAFKA_HEADERS.ACTOR_ID] ?? 'unknown';

      this.logger.debug(
        'Kafka processing started: topic=%s | guestId=%s | actorId=%s',
        KafkaTopics.invitation.deleteUserInvitations,
        payload.userId,
        actorId,
      );

      try {
        await this.invitationWriteService.deleteByGuestId(payload.userId);

        this.logger.debug(
          'Kafka processing completed: topic=%s | guestId=%s | actorId=%s',
          KafkaTopics.invitation.deleteUserInvitations,
          payload.userId,
          actorId,
        );
      } catch (error) {
        this.logger.error(
          'Kafka processing failed: topic=%s | guestId=%s | actorId=%s | error=%o',
          KafkaTopics.invitation.deleteUserInvitations,
          payload.userId,
          actorId,
          error,
        );
        throw error;
      }
    });
  }
}
