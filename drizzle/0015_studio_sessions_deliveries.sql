CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`files` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliveries_run_idx` ON `deliveries` (`run_id`);--> statement-breakpoint
CREATE TABLE `project_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`fork_run_id` text,
	`seed` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fork_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_sessions_project_idx` ON `project_sessions` (`project_id`);--> statement-breakpoint
CREATE TABLE `team_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`owner_id` text,
	`dependencies` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_tasks_session_idx` ON `team_tasks` (`project_id`,`session_id`);--> statement-breakpoint
DROP INDEX `runs_one_active_per_project`;--> statement-breakpoint
ALTER TABLE `runs` ADD `session_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `runs_session_idx` ON `runs` (`project_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_one_active_per_session` ON `runs` (`project_id`,`session_id`) WHERE parent_run_id IS NULL AND status IN ('queued','running','waiting');--> statement-breakpoint
ALTER TABLE `chat_queue` ADD `session_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `chat_queue_session_idx` ON `chat_queue` (`project_id`,`session_id`,`status`);--> statement-breakpoint
ALTER TABLE `messages` ADD `session_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_session_idx` ON `messages` (`project_id`,`session_id`);
--> statement-breakpoint
CREATE INDEX messages_run_idx ON messages(run_id);
--> statement-breakpoint
CREATE INDEX events_run_anchor_idx ON events(project_id,type,json_extract(data,'$.runId'),id) WHERE type IN ('request','step');
--> statement-breakpoint
CREATE INDEX events_message_anchor_idx ON events(project_id,json_extract(data,'$.id'),id) WHERE type='message';
--> statement-breakpoint
WITH turn_starts AS MATERIALIZED (
  SELECT m.project_id, m.run_id, m.rowid AS message_row, m.created_at,
    (SELECT prev.rowid FROM messages prev WHERE prev.project_id=m.project_id AND prev.rowid<m.rowid ORDER BY prev.rowid DESC LIMIT 1) AS previous_row
  FROM messages m JOIN runs r ON r.id=m.run_id
  WHERE m.role='assistant' AND r.parent_run_id IS NULL
), user_turn AS MATERIALIZED (
  SELECT m.id, COALESCE(
    (SELECT q.target_run_id FROM chat_queue q WHERE q.project_id=m.project_id AND q.request_id=m.request_id),
    (SELECT t.run_id FROM turn_starts t WHERE t.project_id=m.project_id AND t.previous_row=m.rowid AND t.created_at=m.created_at),
    (SELECT t.run_id FROM turn_starts t WHERE t.project_id=m.project_id AND t.message_row<m.rowid ORDER BY t.message_row DESC LIMIT 1)
  ) AS run_id FROM messages m WHERE m.role='user' AND m.run_id IS NULL AND m.request_id IS NOT NULL
)
UPDATE messages SET run_id=(SELECT run_id FROM user_turn WHERE user_turn.id=messages.id)
WHERE id IN (SELECT id FROM user_turn WHERE run_id IS NOT NULL);
