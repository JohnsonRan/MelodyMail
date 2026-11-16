CREATE TABLE IF NOT EXISTS `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` integer,
	`to_list` text DEFAULT '[]' NOT NULL,
	`cc_list` text DEFAULT '[]' NOT NULL,
	`bcc_list` text DEFAULT '[]' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`source_id` text,
	`source_kind` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `drafts_idempotency_key` ON `drafts` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drafts_updated` ON `drafts` (`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `send_quota` (
	`id` integer PRIMARY KEY NOT NULL,
	`daily_used` integer NOT NULL,
	`monthly_used` integer NOT NULL,
	`seen_at` integer NOT NULL,
	CONSTRAINT "send_quota_single_row" CHECK("send_quota"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`draft_id` text,
	`message_id` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `uploads_draft` ON `uploads` (`draft_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `uploads_message` ON `uploads` (`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `uploads_created` ON `uploads` (`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `webhook_events` (
	`svix_id` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `webhook_events_received` ON `webhook_events` (`received_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `bcc_hdr` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `resend_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `idempotency_key` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `error` text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `messages_resend_id` ON `messages` (`resend_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `messages_idempotency_key` ON `messages` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_direction_received` ON `messages` (`direction`,`trashed`,"received_at" DESC,"id" DESC);