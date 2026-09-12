-- In-app notifications are persisted in Postgres (channel = 'in_app') so the
-- dashboard feed survives gateway restarts and multiple instances. Track
-- per-notification read state and index the (provider, read) lookup used by
-- the feed and the unread badge.

ALTER TABLE "Notification"
  ADD COLUMN IF NOT EXISTS "read" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Notification_providerId_read_idx"
  ON "Notification" ("providerId", "read");
