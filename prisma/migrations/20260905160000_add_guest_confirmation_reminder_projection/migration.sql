-- AlterTable
ALTER TABLE "event_settings_projection"
ADD COLUMN "guest_confirmation_reminder_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "guest_confirmation_reminder_presets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "guest_confirmation_max_resends" INTEGER,
ADD COLUMN "starts_at" TIMESTAMP(3);