CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` integer NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`envelope_from` text NOT NULL,
	`envelope_to` text NOT NULL,
	`subaddress_tag` text,
	`message_id_hdr` text,
	`in_reply_to` text,
	`references_hdr` text,
	`thread_key` text,
	`subject` text,
	`from_hdr` text,
	`to_hdr` text,
	`cc_hdr` text,
	`date_hdr` text,
	`snippet` text,
	`raw_size` integer NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`r2_key` text NOT NULL,
	`forward_failed` integer DEFAULT 0 NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`trashed` integer DEFAULT false NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_address_received` ON `messages` (`address_id`,"received_at" DESC);--> statement-breakpoint
CREATE INDEX `messages_status_received` ON `messages` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `messages_thread_key` ON `messages` (`thread_key`);--> statement-breakpoint
-- Written by hand: drizzle-kit does not describe virtual tables. The trigram tokenizer matches
-- any 3-character substring, so Chinese and Japanese text without spaces is searchable.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(`message_id` UNINDEXED, `subject`, `sender`, `body`, tokenize = 'trigram');
