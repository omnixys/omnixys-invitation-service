-- CreateEnum
CREATE TYPE "event_role_type" AS ENUM ('ADMIN', 'SECURITY', 'GUEST', 'SUPPORT', 'DRIVER', 'USHER');

-- CreateEnum
CREATE TYPE "invitation_type" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "contact_type" AS ENUM ('EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "phone_number_type" AS ENUM ('WHATSAPP', 'MOBILE', 'PRIVATE', 'WORK', 'HOME', 'OTHER');

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'APPROVAL_STAGED', 'DECLINED', 'CANCELED', 'REJECTED', 'APPROVED');

-- CreateEnum
CREATE TYPE "rsvp_choice" AS ENUM ('YES', 'NO', 'MAYBE');

-- CreateEnum
CREATE TYPE "plus_one_age_category" AS ENUM ('OVER_SIX', 'UNDER_SIX');

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "type" "invitation_type" NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "event_name" TEXT,
    "event_ends_at" TIMESTAMP(3),
    "auto_approve_on_accept" BOOLEAN NOT NULL DEFAULT false,
    "guest_profile_id" UUID,
    "email" TEXT,
    "phone_number" TEXT,
    "selected_invited_by" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "guest_note" TEXT,
    "plus_one_age_category" "plus_one_age_category",
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),
    "pending_contact_id" UUID,
    "rsvp_choice" "rsvp_choice",
    "rsvp_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "max_invitees" INTEGER NOT NULL DEFAULT 0,
    "invited_by_invitation_id" UUID,
    "invited_by_user_id" UUID,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_number" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "type" "phone_number_type" NOT NULL,
    "label" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "country_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "phone_number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_role_projection" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "event_role_type" NOT NULL,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "event_role_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_access_projection" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roles" JSONB,
    "occurred_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "event_access_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_settings_projection" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "tenant_id" UUID,
    "name" TEXT,
    "ends_at" TIMESTAMP(3),
    "approval_mode" TEXT,
    "allow_public_rsvp" BOOLEAN NOT NULL DEFAULT false,
    "require_approval_for_plus_ones" BOOLEAN NOT NULL DEFAULT true,
    "rsvp_deadline" TIMESTAMP(3),
    "max_seats" INTEGER,
    "schedule_ticket_release" BOOLEAN NOT NULL DEFAULT false,
    "ticket_release_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "event_settings_projection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "actor_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "published_at" TIMESTAMP(3),
    "dead_lettered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitation_pending_contact_id_key" ON "invitation"("pending_contact_id");

-- CreateIndex
CREATE INDEX "invitation_event_id_status_idx" ON "invitation"("event_id", "status");

-- CreateIndex
CREATE INDEX "invitation_event_id_rsvp_choice_idx" ON "invitation"("event_id", "rsvp_choice");

-- CreateIndex
CREATE INDEX "invitation_invited_by_invitation_id_idx" ON "invitation"("invited_by_invitation_id");

-- CreateIndex
CREATE INDEX "invitation_event_id_idx" ON "invitation"("event_id");

-- CreateIndex
CREATE INDEX "phone_number_country_code_number_idx" ON "phone_number"("country_code", "number");

-- CreateIndex
CREATE INDEX "phone_number_invitation_id_idx" ON "phone_number"("invitation_id");

-- CreateIndex
CREATE INDEX "phone_number_invitation_id_is_primary_idx" ON "phone_number"("invitation_id", "is_primary");

-- CreateIndex
CREATE INDEX "idx_event_role_projection_event" ON "event_role_projection"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_role_projection_event_id_user_id_key" ON "event_role_projection"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_event_access_projection_event" ON "event_access_projection"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_access_projection_event_id_user_id_key" ON "event_access_projection"("event_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_settings_projection_event_id_key" ON "event_settings_projection"("event_id");

-- CreateIndex
CREATE INDEX "event_settings_projection_tenant_id_idx" ON "event_settings_projection"("tenant_id");

-- CreateIndex
CREATE INDEX "analytics_outbox_published_at_dead_lettered_at_next_attempt_idx" ON "analytics_outbox"("published_at", "dead_lettered_at", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_invitation_id_fkey" FOREIGN KEY ("invited_by_invitation_id") REFERENCES "invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
