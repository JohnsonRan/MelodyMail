CREATE TABLE `address_forwards` (
	`address_id` integer NOT NULL,
	`target_id` integer NOT NULL,
	PRIMARY KEY(`address_id`, `target_id`),
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `forward_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `address_forwards_target_id` ON `address_forwards` (`target_id`);--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`forward_only` integer DEFAULT false NOT NULL,
	`last_received_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`domain`) REFERENCES `domains`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_domain_local_part` ON `addresses` (`domain`,`local_part`);--> statement-breakpoint
CREATE TABLE `domains` (
	`name` text PRIMARY KEY NOT NULL,
	`receive_enabled` integer DEFAULT true NOT NULL,
	`send_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `forward_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forward_targets_email_unique` ON `forward_targets` (`email`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `detail` text;