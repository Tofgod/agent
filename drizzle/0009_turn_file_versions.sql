ALTER TABLE `artifact_versions` ADD `run_id` text REFERENCES runs(id);--> statement-breakpoint
ALTER TABLE `artifact_versions` ADD `path` text;--> statement-breakpoint
ALTER TABLE `artifact_versions` ADD `previous_path` text;--> statement-breakpoint
ALTER TABLE `artifact_versions` ADD `kind` text;--> statement-breakpoint
CREATE INDEX `artifact_versions_run_idx` ON `artifact_versions` (`run_id`);