CREATE TABLE IF NOT EXISTS `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`quiet_foreground` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_single_row" CHECK("settings"."id" = 1)
);
