CREATE TABLE IF NOT EXISTS `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `spam_senders` (
	`address` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS `messages_folder_received`;--> statement-breakpoint
DROP INDEX IF EXISTS `messages_starred_received`;--> statement-breakpoint
DROP INDEX IF EXISTS `messages_unread`;--> statement-breakpoint
ALTER TABLE `messages` ADD `seq` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `spam` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `spam_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `from_key` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_spam_received` ON `messages` (`spam`,"received_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_spam_at` ON `messages` (`spam_at`) WHERE `spam` = 1;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_address_trashed_at` ON `messages` (`address_id`,`trashed_at`) WHERE `trashed` = 1;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_address_spam_at` ON `messages` (`address_id`,`spam_at`) WHERE `spam` = 1;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_seq` ON `messages` (`seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_folder_received` ON `messages` (`trashed`,`archived`,`spam`,"received_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_starred_received` ON `messages` (`starred`,`trashed`,`spam`,"received_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_unread` ON `messages` (`trashed`,`archived`,`spam`,`starred`,`address_id`) WHERE `read` = 0;--> statement-breakpoint
ALTER TABLE `backup_exports` ADD `columns` text;--> statement-breakpoint
ALTER TABLE `rules` ADD `spam` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Written by hand from here: drizzle-kit describes neither data nor triggers.
-- Existing rows get seq in (received_at, id) order, and the counter starts at the highest one
-- (docs/M8-mailbox-ux.md, decision 3). The trigger is created last, so no row is numbered twice.
WITH `ordered` AS (SELECT `id`, ROW_NUMBER() OVER (ORDER BY `received_at`, `id`) AS `n` FROM `messages`)
UPDATE `messages` SET `seq` = `ordered`.`n` FROM `ordered` WHERE `ordered`.`id` = `messages`.`id` AND `messages`.`seq` IS NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `counters` (`name`, `value`) SELECT 'messages_seq', COALESCE(MAX(`seq`), 0) FROM `messages`;--> statement-breakpoint
-- Every INSERT that leaves seq NULL (email(), the sent copy, the gap tool) takes the next value. A
-- restore writes seq as stored, so the trigger leaves those rows alone.
CREATE TRIGGER IF NOT EXISTS `messages_seq_insert` AFTER INSERT ON `messages` WHEN NEW.`seq` IS NULL
BEGIN
	UPDATE `counters` SET `value` = `value` + 1 WHERE `name` = 'messages_seq';
	UPDATE `messages` SET `seq` = (SELECT `value` FROM `counters` WHERE `name` = 'messages_seq') WHERE `rowid` = NEW.`rowid`;
END;
