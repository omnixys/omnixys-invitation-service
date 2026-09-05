import {
  InvitationStatus,
  InvitationType,
  PlusOneAgeCategory,
  RsvpChoice,
} from '../../../prisma/generated/client.js';
import {
  Field,
  GraphQLISODateTime,
  ID,
  Int,
  ObjectType,
} from '@nestjs/graphql';
import { registerEnum } from '@omnixys/graphql-ts';

registerEnum('InvitationStatus', InvitationStatus);
registerEnum('RsvpChoice', RsvpChoice);
registerEnum('InvitationType', InvitationType);
registerEnum('PlusOneAgeCategory', PlusOneAgeCategory);

@ObjectType({
  description: 'GraphQL Invitation entity matching the Prisma model exactly.',
})
export class InvitationPayload {
  @Field(() => ID)
  id!: string;

  @Field(() => InvitationType)
  type!: InvitationType;

  @Field(() => String)
  firstName!: string;

  @Field(() => String)
  lastName!: string;

  @Field(() => ID)
  eventId!: string;

  @Field({ nullable: true })
  eventName?: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  eventEndsAt?: Date;

  @Field(() => Boolean)
  autoApproveOnAccept!: boolean;

  @Field(() => ID, {
    nullable: true,
  })
  guestProfileId?: string;

  @Field(() => String, {
    nullable: true,
  })
  email?: string;

  @Field(() => String, { nullable: true })
  phoneNumber?: string;

  @Field(() => [String])
  selectedInvitedBy!: string[];

  @Field(() => String, { nullable: true })
  guestNote?: string;

  @Field(() => PlusOneAgeCategory, { nullable: true })
  plusOneAgeCategory?: PlusOneAgeCategory;

  @Field(() => InvitationStatus)
  status!: InvitationStatus;

  @Field(() => GraphQLISODateTime)
  createdAt!: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
  })
  updatedAt?: Date | undefined;

  @Field(() => String, {
    nullable: true,
    description: 'Pointer to PII record inside Ephemeral Redis Store.',
  })
  pendingContactId?: string;

  @Field(() => RsvpChoice, {
    nullable: true,
  })
  rsvpChoice?: RsvpChoice;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
  })
  rsvpAt?: Date;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
  })
  approvedAt?: Date;

  @Field(() => ID, {
    nullable: true,
  })
  approvedByUserId?: string;

  @Field(() => Int)
  maxInvitees!: number;

  @Field(() => ID, {
    nullable: true,
  })
  invitedByInvitationId?: string;

  @Field(() => ID, {
    nullable: true,
  })
  invitedByUserId?: string;

  @Field(() => GraphQLISODateTime, {
    nullable: true,
  })
  confirmationSentAt?: Date;

  @Field(() => Int)
  confirmationResendCount!: number;
}
