ALTER TABLE `messages` ADD `inherited` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX events_fork_feed_idx ON events(project_id,type,json_extract(data,'$.id'),id)
  WHERE type='feed:run' OR type='feed:message' OR type='feed:reply' OR type='feed:step' OR type='feed:delivery';
--> statement-breakpoint
ALTER TABLE `projects` ADD `main_session_title` text DEFAULT '主对话' NOT NULL;
