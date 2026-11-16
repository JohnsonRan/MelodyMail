CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`last_used_ip` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_public_id` ON `api_keys` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `api_keys_token_hash` ON `api_keys` (`token_hash`);