import type { Invitation } from '../../../prisma/generated/client.js';
import type { InvitationPayload } from '../payloads/invitation.payload.js';
import { n2u } from '@omnixys/contracts-ts';

/**
 * Maps Prisma Invitation → GraphQL Invitation entity.
 * Required because Prisma enums differ from GraphQL enums.
 */
export class InvitationMapper {
  static toPayload(invitation: Invitation): InvitationPayload {
    return {
      id: invitation.id,
      type: invitation.type,
      status: invitation.status,
      eventId: invitation.eventId,
      eventName: n2u(invitation.eventName),
      eventEndsAt: n2u(invitation.eventEndsAt),
      autoApproveOnAccept: invitation.autoApproveOnAccept,
      firstName: invitation.firstName,
      lastName: invitation.lastName,
      guestProfileId: n2u(invitation.guestProfileId),
      createdAt: invitation.createdAt,
      updatedAt: n2u(invitation.updatedAt),
      pendingContactId: n2u(invitation.pendingContactId),
      rsvpChoice: n2u(invitation.rsvpChoice),
      rsvpAt: n2u(invitation.rsvpAt),
      approvedAt: n2u(invitation.approvedAt),
      approvedByUserId: n2u(invitation.approvedByUserId),
      maxInvitees: invitation.maxInvitees,
      invitedByInvitationId: n2u(invitation.invitedByInvitationId),
      invitedByUserId: n2u(invitation.invitedByUserId),
      confirmationSentAt: n2u(invitation.confirmationSentAt),
      confirmationResendCount: invitation.confirmationResendCount,
      email: n2u(invitation.email),
      phoneNumber: n2u(invitation.phoneNumber),
      selectedInvitedBy: invitation.selectedInvitedBy ?? [],
      guestNote: n2u(invitation.guestNote),
      plusOneAgeCategory: n2u(invitation.plusOneAgeCategory),
    };
  }

  static toPayloadList(list: Invitation[]): InvitationPayload[] {
    return list.map((x) => this.toPayload(x));
  }
}
