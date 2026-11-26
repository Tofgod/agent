CREATE TABLE `chat_queue` (
	`project_id` text NOT NULL,
	`request_id` text NOT NULL,
	`original` text NOT NULL,
	`content` text NOT NULL,
	`attachments` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_queue_request` ON `chat_queue` (`project_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `chat_queue_pending` ON `chat_queue` (`status`,`project_id`);--> statement-breakpoint
CREATE TRIGGER feed_chat_queue_insert AFTER INSERT ON chat_queue BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:chat-queue',json_object('id',NEW.request_id),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_chat_queue_update AFTER UPDATE ON chat_queue BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:chat-queue',json_object('id',NEW.request_id),NEW.updated_at);
END;
