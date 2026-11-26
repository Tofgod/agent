ALTER TABLE `messages` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `attachments` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_request` ON `messages` (`project_id`,`request_id`);