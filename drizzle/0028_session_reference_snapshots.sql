CREATE TABLE `session_reference_lines` (
	`snapshot_id` text NOT NULL,
	`line` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`snapshot_id`, `line`),
	FOREIGN KEY (`snapshot_id`) REFERENCES `session_reference_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_reference_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`preview` text NOT NULL,
	`total_lines` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_reference_capture_idx` ON `session_reference_snapshots` (`project_id`,`target_session_id`,`input_id`,`source_session_id`);