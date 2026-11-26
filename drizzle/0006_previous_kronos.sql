CREATE TABLE `model_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`request` text NOT NULL,
	`status` text NOT NULL,
	`visible_text` text DEFAULT '' NOT NULL,
	`response` text,
	`usage` text,
	`provider_request_id` text,
	`error` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `model_calls_run_idx` ON `model_calls` (`run_id`);