CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` text NOT NULL,
	`config` text NOT NULL,
	`secrets` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_preset_bindings` (
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`project_id`, `session_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `studio_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`data` text NOT NULL,
	`status` text NOT NULL,
	`next_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`last` text,
	`session_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `studio_schedules_due` ON `studio_schedules` (`status`,`next_at`);--> statement-breakpoint
CREATE INDEX `studio_schedules_project` ON `studio_schedules` (`project_id`);--> statement-breakpoint
ALTER TABLE `agent_session_events` ADD `event_seq` integer;
--> statement-breakpoint
CREATE TRIGGER studio_trajectory_checkpoint AFTER INSERT ON agent_session_events
BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  SELECT project_id,'trajectory/checkpoint',json_object('runId',id,'revision',NEW.revision,'turn',generation,'phase',NEW.kind),NEW.created_at
  FROM runs WHERE id=NEW.run_id;
  UPDATE agent_session_events SET event_seq=last_insert_rowid() WHERE run_id=NEW.run_id AND revision=NEW.revision;
END;
--> statement-breakpoint
UPDATE agent_session_events AS journal SET event_seq=(
  SELECT MIN(e.id) FROM runs r JOIN events e ON e.project_id=r.project_id
  WHERE r.id=journal.run_id AND json_extract(e.data,'$.runId')=r.id
    AND json_extract(e.data,'$.requestId')=journal.reference
    AND (journal.kind='model/request' AND e.type='request'
      OR journal.kind IN ('model/accepted','context/compacted') AND e.type='reply' AND json_extract(e.data,'$.status')='completed')
) WHERE journal.reference IS NOT NULL AND journal.kind IN ('model/request','model/accepted','context/compacted');

--> statement-breakpoint
DROP TRIGGER agent_recheck_terminal_receipt;
--> statement-breakpoint
CREATE TRIGGER agent_recheck_terminal_receipt AFTER INSERT ON events
WHEN NEW.type IN ('step','reply')
BEGIN
  UPDATE runs SET lease_until=lease_until WHERE id=json_extract(NEW.data,'$.runId') AND project_id=NEW.project_id
    AND agent_role<>'media' AND status IN ('failed','cancelled')
    AND json_extract(payload,'$.inherited') IS NOT 1 AND json_extract(payload,'$.imported') IS NOT 1;
END;
