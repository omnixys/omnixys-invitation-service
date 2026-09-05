-- invitation: user/contact reference fields store UserId values (U), align UUID type.
-- pending_contact_id keeps its existing unique index.
-- Values are (re)seeded as UUIDs after the UUIDv7 migration, plain casts are safe.
ALTER TABLE "invitation"
    ALTER COLUMN "pending_contact_id" TYPE UUID USING "pending_contact_id"::uuid,
    ALTER COLUMN "approved_by_user_id" TYPE UUID USING "approved_by_user_id"::uuid;

-- analytics_outbox.actor_id references a UserId (U), align UUID type.
ALTER TABLE "analytics_outbox"
    ALTER COLUMN "actor_id" TYPE UUID USING "actor_id"::uuid;