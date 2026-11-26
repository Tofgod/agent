CREATE TABLE `tool_receipts` (
	`run_id` text NOT NULL,
	`call_id` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_receipts_call` ON `tool_receipts` (`run_id`,`call_id`);