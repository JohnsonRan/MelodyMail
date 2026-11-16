CREATE INDEX IF NOT EXISTS `messages_folder_received` ON `messages` (`trashed`,`archived`,"received_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_starred_received` ON `messages` (`starred`,`trashed`,"received_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_unread` ON `messages` (`trashed`,`archived`,`starred`,`address_id`) WHERE `read` = 0;
