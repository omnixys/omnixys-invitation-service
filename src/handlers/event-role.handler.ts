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

import {
  EventRoleType as PrismaEventRoleType,
  Prisma,
} from '../prisma/generated/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Injectable } from '@nestjs/common';
import type {
  EventAccessDTO,
  EventIdsDTO,
  EventOwnerChangedDTO,
  EventRoleAssignedDTO,
  EventRoleRemovedDTO,
} from '@omnixys/contracts-ts';
import {
  KafkaEvent,
  KafkaEventHandler,
  KafkaTopics,
  type IKafkaEventContext,
} from '@omnixys/kafka-ts';
import { OmnixysLogger, type ScopedLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';

@KafkaEventHandler('event')
@Injectable()
export class EventRoleHandler {
  private readonly logger: ScopedLogger;

  constructor(
    private readonly omnixysLogger: OmnixysLogger,
    private readonly prisma: PrismaService,
  ) {
    this.logger = this.omnixysLogger.log(
      'service:invitation',
      this.constructor.name,
    );
  }

  @KafkaEvent(KafkaTopics.event.userAccessChanged)
  async handleUserAccessChanged(
    payload: EventAccessDTO,
    _context: IKafkaEventContext,
  ): Promise<void> {
    return TraceRunner.run('[HANDLER] event.userAccessChanged', async () => {
      const { eventId, userId, permissions, roles, occurredAt } = payload;
      const occurredAtDate = new Date(occurredAt);

      this.logger.info('event_user_access_changed_received: %o', {
        eventId,
        userId,
      });

      const existing = await this.prisma.eventAccessProjection.findUnique({
        where: { uq_event_access_projection: { eventId, userId } },
        select: { occurredAt: true },
      });

      if (
        existing?.occurredAt &&
        occurredAtDate.getTime() < existing.occurredAt.getTime()
      ) {
        this.logger.debug('Skipping stale event.userAccessChanged: %o', {
          eventId,
          userId,
        });
        return;
      }

      try {
        await this.prisma.eventAccessProjection.upsert({
          where: { uq_event_access_projection: { eventId, userId } },
          create: {
            eventId,
            userId,
            permissions,
            roles: roles as unknown as Prisma.InputJsonValue,
            occurredAt: occurredAtDate,
          },
          update: {
            permissions,
            roles: roles as unknown as Prisma.InputJsonValue,
            occurredAt: occurredAtDate,
          },
        });
        this.logger.info('event_user_access_changed_upserted: %o', {
          eventId,
          userId,
        });
      } catch (error) {
        this.logger.error('event_user_access_changed_failed: %o', {
          eventId,
          userId,
          error,
        });
        throw error;
      }
    });
  }

  @KafkaEvent(KafkaTopics.event.roleAssigned)
  async handleRoleAssigned(
    payload: EventRoleAssignedDTO,
    _context: IKafkaEventContext,
  ): Promise<void> {
    return TraceRunner.run('[HANDLER] event.roleAssigned', async () => {
      const { eventId, userId, role, occurredAt } = payload;
      const projectedRole = role as unknown as PrismaEventRoleType;

      this.logger.info('event_role_assigned_received: %o', {
        eventId,
        userId,
        role,
      });

      const existing = await this.prisma.eventRoleProjection.findUnique({
        where: { uq_event_role_projection: { eventId, userId } },
        select: { updatedAt: true },
      });

      if (
        existing?.updatedAt &&
        new Date(occurredAt).getTime() < existing.updatedAt.getTime()
      ) {
        this.logger.debug('Skipping stale event.roleAssigned: %o', {
          eventId,
          userId,
        });
        return;
      }

      try {
        await this.prisma.eventRoleProjection.upsert({
          where: { uq_event_role_projection: { eventId, userId } },
          create: { eventId, userId, role: projectedRole },
          update: { role: projectedRole },
        });
        this.logger.info('event_role_assigned_upserted: %o', {
          eventId,
          userId,
          role,
        });
      } catch (error) {
        this.logger.error('event_role_assigned_failed: %o', {
          eventId,
          userId,
          role,
          error,
        });
        throw error;
      }
    });
  }

  @KafkaEvent(KafkaTopics.event.roleRemoved)
  async handleRoleRemoved(
    payload: EventRoleRemovedDTO,
    _context: IKafkaEventContext,
  ): Promise<void> {
    return TraceRunner.run('[HANDLER] event.roleRemoved', async () => {
      const { eventId, userId, occurredAt } = payload;

      this.logger.info('event_role_removed_received: %o', { eventId, userId });

      const existing = await this.prisma.eventRoleProjection.findUnique({
        where: { uq_event_role_projection: { eventId, userId } },
        select: { updatedAt: true },
      });

      if (
        existing?.updatedAt &&
        new Date(occurredAt).getTime() < existing.updatedAt.getTime()
      ) {
        this.logger.debug('Skipping stale event.roleRemoved: %o', {
          eventId,
          userId,
        });
        return;
      }

      try {
        await this.prisma.eventRoleProjection.deleteMany({
          where: { eventId, userId },
        });
        this.logger.info('event_role_removed_success: %o', { eventId, userId });
      } catch (error) {
        this.logger.error('event_role_removed_failed: %o', {
          eventId,
          userId,
          error,
        });
        throw error;
      }
    });
  }

  @KafkaEvent(KafkaTopics.event.ownerChanged)
  async handleOwnerChanged(
    payload: EventOwnerChangedDTO,
    _context: IKafkaEventContext,
  ): Promise<void> {
    return TraceRunner.run('[HANDLER] event.ownerChanged', async () => {
      const { eventId, oldOwnerId, newOwnerId, occurredAt } = payload;

      this.logger.info('event_owner_changed_received: %o', {
        eventId,
        oldOwnerId,
        newOwnerId,
      });

      try {
        if (oldOwnerId) {
          const existing = await this.prisma.eventRoleProjection.findUnique({
            where: {
              uq_event_role_projection: { eventId, userId: oldOwnerId },
            },
            select: { updatedAt: true },
          });

          if (
            !existing?.updatedAt ||
            new Date(occurredAt).getTime() >= existing.updatedAt.getTime()
          ) {
            await this.prisma.eventRoleProjection.deleteMany({
              where: { eventId, userId: oldOwnerId },
            });
          }
        }

        const existingNew = await this.prisma.eventRoleProjection.findUnique({
          where: { uq_event_role_projection: { eventId, userId: newOwnerId } },
          select: { updatedAt: true },
        });

        if (
          existingNew?.updatedAt &&
          new Date(occurredAt).getTime() < existingNew.updatedAt.getTime()
        ) {
          this.logger.debug('Skipping stale ownerChanged upsert: %o', {
            eventId,
            userId: newOwnerId,
          });
          return;
        }

        await this.prisma.eventRoleProjection.upsert({
          where: { uq_event_role_projection: { eventId, userId: newOwnerId } },
          create: { eventId, userId: newOwnerId, role: 'ADMIN' },
          update: { role: 'ADMIN' },
        });
        this.logger.info('event_owner_changed_upserted: %o', {
          eventId,
          newOwnerId,
        });
      } catch (error) {
        this.logger.error('event_owner_changed_failed: %o', {
          eventId,
          oldOwnerId,
          newOwnerId,
          error,
        });
        throw error;
      }
    });
  }

  @KafkaEvent(KafkaTopics.event.deleted)
  async handleEventDeleted(
    payload: EventIdsDTO,
    _context: IKafkaEventContext,
  ): Promise<void> {
    return TraceRunner.run('[HANDLER] event.deleted', async () => {
      this.logger.info('event_deleted_received: %o', {
        eventIds: payload.eventIds,
      });

      try {
        await Promise.all([
          this.prisma.eventRoleProjection.deleteMany({
            where: { eventId: { in: payload.eventIds } },
          }),
          this.prisma.eventSettingsProjection.deleteMany({
            where: { eventId: { in: payload.eventIds } },
          }),
          this.prisma.eventAccessProjection.deleteMany({
            where: { eventId: { in: payload.eventIds } },
          }),
        ]);
        this.logger.info('event_deleted_projections_removed: %o', {
          eventIds: payload.eventIds,
        });
      } catch (error) {
        this.logger.error('event_deleted_failed: %o', {
          eventIds: payload.eventIds,
          error,
        });
        throw error;
      }
    });
  }
}
