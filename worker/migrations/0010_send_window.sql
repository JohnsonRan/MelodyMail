ALTER TABLE `messages` ADD `first_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `maybe_accepted` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Rows from before this migration: their first attempt time is not known, only the last one. An
-- unfinished row is treated as possibly accepted and past Resend's window, so it is never sent
-- again under its key (owner ruling 13, 2026-11-16); it can still be sent as a new message.
UPDATE `messages` SET `first_attempt_at` = `received_at` WHERE `direction` = 'out' AND `first_attempt_at` IS NULL AND `status` NOT IN ('sending', 'failed');--> statement-breakpoint
UPDATE `messages` SET `first_attempt_at` = 0, `maybe_accepted` = 1 WHERE `direction` = 'out' AND `first_attempt_at` IS NULL;
