CREATE TABLE IF NOT EXISTS `rule_forwards` (
	`rule_id` integer NOT NULL,
	`target_id` integer NOT NULL,
	PRIMARY KEY(`rule_id`, `target_id`),
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `forward_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rule_forwards_target_id` ON `rule_forwards` (`target_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`position` integer NOT NULL,
	`match` text NOT NULL,
	`conditions` text NOT NULL,
	`mark_read` integer DEFAULT 0 NOT NULL,
	`star` integer DEFAULT 0 NOT NULL,
	`archive` integer DEFAULT 0 NOT NULL,
	`trash` integer DEFAULT 0 NOT NULL,
	`stop` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "rules_match" CHECK("rules"."match" IN ('all', 'any'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rules_enabled_position` ON `rules` (`enabled`,`position`);