CREATE TABLE IF NOT EXISTS `backup_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`table_index` integer DEFAULT 0 NOT NULL,
	`last_rowid` integer DEFAULT 0 NOT NULL,
	`part_seq` integer DEFAULT 0 NOT NULL,
	`rows_json` text DEFAULT '{}' NOT NULL,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	`alerted_at` integer,
	`pruned_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `backup_exports_status_started` ON `backup_exports` (`status`,`started_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `trashed_at` integer;--> statement-breakpoint
-- Messages already in Trash count from this migration (owner ruling 3, 2026-11-17). Migrations run
-- before the code deploy, so the cron also stamps any row the old code moves to Trash meanwhile.
UPDATE `messages` SET `trashed_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `trashed` = 1 AND `trashed_at` IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_trashed_at` ON `messages` (`trashed_at`) WHERE `trashed` = 1;
