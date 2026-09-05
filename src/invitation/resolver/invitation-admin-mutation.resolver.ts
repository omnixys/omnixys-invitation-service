import { InvitationValidationException } from '../errors/invitation-domain.error.js';
import { ApproveInvitationInput } from '../models/input/approve.input.js';
import { BulkApproveInvitationInput } from '../models/input/bulk-approve.input.js';
import { BulkStageInvitationInput } from '../models/input/bulk-stage.input.js';
import { InvitationCreateInput } from '../models/input/create-invitation.input.js';
import {
  ImportInvitationsInput,
  ImportInvitationsResult,
} from '../models/input/import-invitation.input.js';
import { InvitationPayload } from '../models/payloads/invitation.payload.js';
import { ResendGuestConfirmationsPayload } from '../models/payloads/resend-guest-confirmations.payload.js';
import { SuccessPayload } from '../models/payloads/success.payload.js';
import { AdminWriteService } from '../service/invitation-admin.write.service.js';
import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { EventPermissionKey, RealmRoleType } from '@omnixys/contracts-ts';
import { OmnixysLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';
import {
  CookieAuthGuard,
  CurrentEventId,
  CurrentUser,
  CurrentUserData,
  EventPermissionGuard,
  EventPermissions,
  RoleGuard,
  Roles,
} from '@omnixys/security-ts';

export enum UploadType {
  CSV = 'csv',
  XLSX = 'xlsx',
}

@Resolver(() => InvitationPayload)
export class AdminMutationResolver {
  private readonly logger;
  constructor(
    private readonly loggerService: OmnixysLogger,
    private readonly adminService: AdminWriteService,
  ) {
    this.logger = this.loggerService.log(
      'service:invitation',
      this.constructor.name,
    );
  }

  @UseGuards(CookieAuthGuard, RoleGuard, EventPermissionGuard)
  @Roles(RealmRoleType.USER)
  @EventPermissions(EventPermissionKey.ManageInvitations)
  @Mutation(() => InvitationPayload)
  async createInvitation(
    @Args('input')
    input: InvitationCreateInput,
    @CurrentUser() user: CurrentUserData,
  ): Promise<InvitationPayload> {
    return this.adminService.create(input, user.id);
  }

  @UseGuards(CookieAuthGuard, RoleGuard, EventPermissionGuard)
  @Roles(RealmRoleType.USER)
  @EventPermissions(EventPermissionKey.ManageInvitations)
  @Mutation(() => ImportInvitationsResult, {
    description: 'Imports invitations from CSV/XLSX stored in object storage',
  })
  async importInvitations(
    @Args('input', { type: () => ImportInvitationsInput })
    input: ImportInvitationsInput,
    @CurrentUser() user: CurrentUserData,
  ): Promise<ImportInvitationsResult> {
    return TraceRunner.run('[RESOLVER] importInvitations', async () => {
      if (!input.eventId) {
        throw new InvitationValidationException('Event ID is required');
      }

      if (!input.key || !input.uploadType) {
        throw new InvitationValidationException(
          'Storage key and upload type are required',
        );
      }

      this.logger.debug('Import invitations requested: %o', {
        actorId: user.id,
        eventId: input.eventId,
        key: input.key,
        uploadType: input.uploadType,
      });

      const result = await this.adminService.importInvitations(
        input.eventId,
        input.key,
        input.uploadType,
        user.id,
      );

      this.logger.debug('Import completed: %o', {
        actorId: user.id,
        duplicates: result.duplicates.length,
        imported: result.imported,
        skipped: result.skipped,
        total: result.total,
      });

      return result;
    });
  }

  @UseGuards(CookieAuthGuard, RoleGuard, EventPermissionGuard)
  @Roles(RealmRoleType.USER)
  @EventPermissions(EventPermissionKey.ApproveGuests)
  @Mutation(() => InvitationPayload)
  async approveInvitation(
    @Args('input', {
      type: () => ApproveInvitationInput,
    })
    input: ApproveInvitationInput,
    @CurrentEventId() activeEventId: string | undefined,
    @CurrentUser()
    user: CurrentUserData,
  ): Promise<InvitationPayload> {
    return TraceRunner.run('[RESOLVER] approveInvitation', async () => {
      const result = await this.adminService.approve({
        id: input.invitationId,
        approve: input.approved,
        actorId: user.id,
        seatId: input.seatId,
        activeEventId: activeEventId ?? input.eventId,
      });

      return result;
    });
  }

  @UseGuards(CookieAuthGuard, RoleGuard, EventPermissionGuard)
  @Roles(RealmRoleType.USER)
  @EventPermissions(EventPermissionKey.ManageInvitations)
  @Mutation(() => SuccessPayload)
  async removeInvitation(
    @Args('id', {
      type: () => ID,
    })
    id: string,
    @CurrentEventId() activeEventId: string | undefined,
    @CurrentUser() user: CurrentUserData,
  ): Promise<SuccessPayload> {
    const ok = await this.adminService.delete(id, user.id, activeEventId);
    return {
      ok,
      message: `Einladung '${id}' Gelöscht`,
    };
  }

  @UseGuards(CookieAuthGuard, RoleGuard, EventPermissionGuard)
  @Roles(RealmRoleType.USER)
  @EventPermissions(EventPermissionKey.ApproveGuests)
  @Mutation(() => [InvitationPayload])
  async bulkApproveInvitations(
    @Args('input', { type: () => BulkApproveInvitationInput })
    input: BulkApproveInvitationInput,

    @CurrentEventId() activeEventId: string | undefined,
    @CurrentUser() user: CurrentUserData,
  ): Promise<InvitationPayload[]> {
    return TraceRunner.run('[RESOLVER] bulkApproveInvitations', async () => {
      if (!input.invitationIds?.length) {
        throw new InvitationValidationException(
          'Invitation IDs must not be empty',
        );
      }

      this.logger.debug('Bulk approve requested: %o', {
        actorId: user.id,
        count: input.invitationIds.length,
      });

      return this.adminService.bulkApprove({
        invitationIds: input.invitationIds,
        approved: input.approved,
        actorId: user.id,
        activeEventId,
      });
    });
  }

  @UseGuards(CookieAuthGuard, RoleGuard, EventPermissionGuard)
  @Roles(RealmRoleType.USER)
  @EventPermissions(EventPermissionKey.ApproveGuests)
  @Mutation(() => [InvitationPayload], {
    description:
      'Stages invitations without creating guests, tickets, or notifications.',
  })
  async bulkStageInvitations(
    @Args('input', { type: () => BulkStageInvitationInput })
    input: BulkStageInvitationInput,
    @CurrentEventId() activeEventId: string | undefined,
    @CurrentUser() user: CurrentUserData,
  ): Promise<InvitationPayload[]> {
    if (!input.invitationIds?.length) {
      throw new InvitationValidationException(
        'Invitation IDs must not be empty',
      );
    }

    return this.adminService.bulkStage({
      invitationIds: input.invitationIds.map((item) => item.invitationId),
      staged: input.staged,
      actorId: user.id,
      activeEventId,
    });
  }

  @UseGuards(CookieAuthGuard, RoleGuard, EventPermissionGuard)
  @Roles(RealmRoleType.USER)
  @EventPermissions(EventPermissionKey.ApproveGuests)
  @Mutation(() => ResendGuestConfirmationsPayload, {
    description:
      'Re-sends the confirmation message (email or WhatsApp) to guests who have not yet completed their registration.',
  })
  async resendGuestConfirmations(
    @Args('invitationIds', { type: () => [ID] })
    invitationIds: string[],
    @CurrentEventId() activeEventId: string | undefined,
    @CurrentUser() user: CurrentUserData,
  ): Promise<ResendGuestConfirmationsPayload> {
    if (!invitationIds?.length) {
      throw new InvitationValidationException(
        'Invitation IDs must not be empty',
      );
    }

    return this.adminService.resendGuestConfirmations(
      invitationIds,
      user.id,
      activeEventId,
    );
  }
}
