CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`challenge` text NOT NULL,
	`totp_secret` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempts_scope_created_at` ON `login_attempts` (`scope`,`created_at`);--> statement-breakpoint
CREATE TABLE `owner` (
	`id` integer PRIMARY KEY NOT NULL,
	`totp_secret` text NOT NULL,
	`totp_last_step` integer DEFAULT 0 NOT NULL,
	`recovery_key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "owner_single_row" CHECK("owner"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_at` ON `sessions` (`expires_at`);