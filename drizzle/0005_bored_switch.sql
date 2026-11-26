CREATE TABLE `agent_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_inputs_run_idx` ON `agent_inputs` (`run_id`);--> statement-breakpoint
DROP INDEX `runs_one_active_per_project`;--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_run_id` text REFERENCES runs(id);--> statement-breakpoint
ALTER TABLE `runs` ADD `agent_role` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `input_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `stream_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `result_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `runs_parent_idx` ON `runs` (`parent_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_per_project` ON `runs` (`project_id`) WHERE parent_run_id IS NULL AND status IN ('queued','running','waiting');