import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType({
  description: 'Per-invitation result of a guest confirmation resend.',
})
export class ResendGuestConfirmationItem {
  @Field(() => ID)
  invitationId!: string;

  @Field({
    description: 'Whether the confirmation message was re-issued.',
  })
  resent!: boolean;

  @Field(() => String, {
    nullable: true,
    description:
      'Reason a resend was skipped, when applicable (already-registered, invalid-status, event-ended, missing-payload, rate-limited).',
  })
  reason?: string | null;
}

@ObjectType({
  description: 'Aggregate result of resending guest confirmation messages.',
})
export class ResendGuestConfirmationsPayload {
  @Field()
  total!: number;

  @Field()
  resent!: number;

  @Field()
  skipped!: number;

  @Field(() => [ResendGuestConfirmationItem])
  results!: ResendGuestConfirmationItem[];
}
