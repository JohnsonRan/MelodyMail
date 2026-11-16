CREATE TABLE IF NOT EXISTS `telegram` (
	`id` integer PRIMARY KEY NOT NULL,
	`bot_username` text NOT NULL,
	`origin` text NOT NULL,
	`webhook_secret_hash` text NOT NULL,
	`link_code_hash` text,
	`link_expires_at` integer,
	`chat_id` integer,
	`chat_label` text,
	`language` text,
	`bound_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "telegram_single_row" CHECK("telegram"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `telegram_cards` (
	`message_id` text PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`tg_message_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `telegram_cards_chat_message` ON `telegram_cards` (`chat_id`,`tg_message_id`);