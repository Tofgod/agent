CREATE TABLE `background_job_output` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`line` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `background_job_output_cursor` ON `background_job_output` (`job_id`,`seq`);--> statement-breakpoint
CREATE TABLE `background_job_reads` (
	`job_id` text NOT NULL,
	`owner` text NOT NULL,
	`cursor` integer NOT NULL,
	`terminal` text,
	PRIMARY KEY(`job_id`, `owner`),
	FOREIGN KEY (`job_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `background_wake_budget` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`owner` text NOT NULL,
	`used` integer NOT NULL,
    `user_seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`project_id`, `session_id`, `owner`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `disk_workspace_files` (
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`artifact_id` text NOT NULL,
	`version` integer NOT NULL,
	`stamp` text NOT NULL,
	PRIMARY KEY(`project_id`, `path`),
	FOREIGN KEY (`project_id`) REFERENCES `disk_workspaces`(`project_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `disk_workspaces` (
	`project_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE TRIGGER job_output_bound AFTER INSERT ON background_job_output
BEGIN
  DELETE FROM background_job_output WHERE job_id=NEW.job_id AND seq <= (
    SELECT seq FROM background_job_output WHERE job_id=NEW.job_id ORDER BY seq DESC LIMIT 1 OFFSET 511
  );
END;
--> statement-breakpoint
CREATE TRIGGER job_output_started AFTER INSERT ON runs WHEN NEW.background=1
BEGIN
  INSERT INTO background_job_output(job_id,line,created_at) VALUES(NEW.id,NEW.label,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER job_output_progress AFTER UPDATE OF status,label,progress,error ON runs
WHEN NEW.background=1 AND (
  NEW.status<>OLD.status OR NEW.label<>OLD.label OR NEW.progress<>OLD.progress OR NEW.error IS NOT OLD.error
)
BEGIN
  INSERT INTO background_job_output(job_id,line,created_at)
  VALUES(NEW.id,NEW.label || CASE WHEN NEW.progress>0 AND NEW.progress<100 THEN ' · '||NEW.progress||'%' ELSE '' END
    || CASE WHEN NEW.error IS NOT NULL THEN ' · '||substr(NEW.error,1,500) ELSE '' END,NEW.updated_at);
END;
