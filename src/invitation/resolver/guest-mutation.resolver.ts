import { CreatePlusOneInput } from '../models/input/plus-one.input.js';
import { PublicRsvpInput } from '../models/input/public-rsvp.input.js';
import { RSVPInput } from '../models/input/rsvp.input.js';
import { UpdatePlusOneInput } from '../models/input/update-plus-one.input.js';
import { InvitationPayload } from '../models/payloads/invitation.payload.js';
import {
  // CreatePlusOneInput,
  GuestWriteService,
} from '../service/guest-write.service.js';
import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';
import { ClientInfo, type ClientContext } from '@omnixys/context-ts';
import { OmnixysLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';
import {
  CookieAuthGuard,
  CurrentUser,
  CurrentUserData,
} from '@omnixys/security-ts';

@Resolver(() => InvitationPayload)
export class GuestMutationResolver {
  private readonly logger;
  constructor(
    private readonly loggerService: OmnixysLogger,
    private readonly guestService: GuestWriteService,
  ) {
    this.logger = this.loggerService.log(
      'service:invitation',
      this.constructor.name,
    );
  }

  @UseGuards(CookieAuthGuard)
  @Mutation(() => InvitationPayload)
  async createPlusOnesInvitation(
    @Args('input')
    input: CreatePlusOneInput,
    @CurrentUser() user: CurrentUserData,
    @ClientInfo() clientInfo: ClientContext,
  ): Promise<InvitationPayload> {
    return TraceRunner.run('[RESOLVER] createPlusOnesInvitation', async () =>
      this.guestService.createPlusOne({
        input,
        actorId: user.id,
        clientInfo,
      }),
    );
  }

  @UseGuards(CookieAuthGuard)
  @Mutation(() => InvitationPayload)
  async updatePlusOnesInvitation(
    @Args('input')
    input: UpdatePlusOneInput,
    @CurrentUser() user: CurrentUserData,
  ): Promise<InvitationPayload> {
    return TraceRunner.run('[RESOLVER] updatePlusOnesInvitation', async () =>
      this.guestService.updatePlusOne(input, user.id),
    );
  }
  @Mutation(() => InvitationPayload)
  async replyInvitation(
    @Args('input', {
      type: () => RSVPInput,
    })
    input: RSVPInput,
    @ClientInfo() clientInfo: ClientContext,
  ): Promise<InvitationPayload> {
    return TraceRunner.run('[RESOLVER] approve', async () =>
      this.guestService.reply(input, clientInfo),
    );
  }

  @Mutation(() => InvitationPayload)
  @UseGuards(CookieAuthGuard)
  async removePlusOneInvitation(
    @Args('id', {
      type: () => ID,
    })
    id: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<InvitationPayload> {
    this.logger.debug(
      'removePlusOneInvitation: invitationId=%s | actorId=%s',
      id,
      user.id,
    );
    return this.guestService.deletePlusOne(id, user.id);
  }

  // 🔻 NEU: Alle Plus-Ones einer Parent-Einladung löschen (gibt alle Slots zurück)
  @Mutation(() => [InvitationPayload])
  @UseGuards(CookieAuthGuard)
  async removeAllPlusOnesByInvitationId(
    @Args('invitedByInvitationId', {
      type: () => ID,
    })
    invitedByInvitationId: string,
    @CurrentUser() user: CurrentUserData,
  ): Promise<InvitationPayload[]> {
    return this.guestService.deleteAllPlusOnes(invitedByInvitationId, user.id);
  }

  @Mutation(() => InvitationPayload)
  async createInvitationFromRsvp(
    @Args('input') input: PublicRsvpInput,
    @ClientInfo() clientContext: ClientContext,
  ): Promise<InvitationPayload> {
    return TraceRunner.run('[RESOLVER] createInvitationFromRsvp', async () => {
      this.logger.debug(
        '[RSVP] Public RSVP submission for event %s',
        input.eventId,
      );
      return this.guestService.createFromPublicRsvp(input, clientContext);
    });
  }
}
