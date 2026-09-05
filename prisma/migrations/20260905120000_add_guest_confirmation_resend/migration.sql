-- invitation: persist the pending guest payload for confirmation resend,
-- plus last-confirmation tracking used by the scheduled reminder.
ALTER TABLE "invitation"
    ADD COLUMN "pending_contact_payload" JSONB,
    ADD COLUMN "confirmation_sent_at" TIMESTAMP(3),
    ADD COLUMN "confirmation_resend_count" INTEGER NOT NULL DEFAULT 0;