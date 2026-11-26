CREATE TABLE `team_modes` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`project_id`, `session_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `team_tasks` ADD `write_scopes` text DEFAULT '[]' NOT NULL;