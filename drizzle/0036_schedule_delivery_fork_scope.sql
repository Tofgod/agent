ALTER TABLE project_sessions ADD COLUMN working_directory text;
--> statement-breakpoint
ALTER TABLE chat_queue ADD COLUMN scheduled_frame text;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN turn_preset text;
--> statement-breakpoint
ALTER TABLE studio_schedules ADD COLUMN updated_at text;
--> statement-breakpoint
CREATE TABLE archived_fork_checkpoints (
  run_id text NOT NULL REFERENCES runs(id),
  revision integer NOT NULL,
  event_seq integer REFERENCES events(id),
  patch text NOT NULL,
  PRIMARY KEY (run_id,revision)
);
--> statement-breakpoint
CREATE INDEX archived_event_sequence ON events(project_id,json_extract(data,'$.archiveSeq'))
  WHERE json_extract(data,'$.archiveSeq') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX tool_dispatch_event ON events(project_id,json_extract(data,'$.runId'),json_extract(data,'$.callId'),id)
  WHERE type='tool/dispatched';
