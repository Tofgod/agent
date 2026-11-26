CREATE TABLE `execution_steps` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`arguments` text NOT NULL,
	`result` text,
	`summary` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_steps_call` ON `execution_steps` (`run_id`,`call_id`);--> statement-breakpoint
CREATE INDEX `execution_steps_project` ON `execution_steps` (`project_id`,`seq`);