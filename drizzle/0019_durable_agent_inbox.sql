CREATE TABLE `agent_inbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text,
	`target` text NOT NULL,
	`wake` integer NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`content` text NOT NULL,
	`attachments` text,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_id` ON `agent_inbox` (`project_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_inbox_delivery` ON `agent_inbox` (`project_id`,`session_id`,`run_id`,`state`,`seq`);
--> statement-breakpoint
CREATE TRIGGER inbox_user_message AFTER INSERT ON messages
WHEN NEW.role='user' AND NEW.inherited=0
BEGIN
  INSERT INTO agent_inbox(id,project_id,session_id,run_id,target,wake,kind,state,content,attachments,created_at)
  VALUES(NEW.id,NEW.project_id,NEW.session_id,NEW.run_id,
    CASE WHEN EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id) THEN 'next-step' ELSE 'next-turn' END,
    1,'user','ready',NEW.content,NEW.attachments,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER inbox_collaboration AFTER INSERT ON agent_inputs
BEGIN
  INSERT INTO agent_inbox(id,project_id,session_id,run_id,target,wake,kind,state,content,source,created_at)
  SELECT NEW.id,r.project_id,r.session_id,r.id,
    CASE WHEN json_extract(NEW.source,'$.kind')='delegation' THEN 'next-turn' ELSE 'next-step' END,
    1,'agent','ready',NEW.content,NEW.source,NEW.created_at FROM runs r WHERE r.id=NEW.run_id;
END;
--> statement-breakpoint
CREATE TRIGGER inbox_queue_insert AFTER INSERT ON chat_queue WHEN NEW.status='pending'
BEGIN
  INSERT INTO agent_inbox(id,project_id,session_id,run_id,target,wake,kind,state,content,attachments,created_at)
  VALUES('queue:'||NEW.request_id,NEW.project_id,NEW.session_id,NEW.target_run_id,
    CASE WHEN NEW.target_run_id IS NULL THEN 'next-turn' ELSE 'next-step' END,1,'queue','pending',NEW.content,NEW.attachments,NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER inbox_queue_update AFTER UPDATE OF target_run_id,status,content,attachments ON chat_queue
BEGIN
  UPDATE agent_inbox SET run_id=NEW.target_run_id, target=CASE WHEN NEW.target_run_id IS NULL THEN 'next-turn' ELSE 'next-step' END,
    state=NEW.status,content=NEW.content,attachments=NEW.attachments
  WHERE project_id=NEW.project_id AND id='queue:'||NEW.request_id;
END;
--> statement-breakpoint
CREATE TRIGGER inbox_task_settlement AFTER UPDATE OF status,generation,payload ON runs
WHEN NEW.parent_run_id IS NOT NULL AND NEW.status IN ('done','failed','cancelled','paused')
  AND (OLD.status<>NEW.status OR OLD.generation<>NEW.generation
    OR json_extract(OLD.payload,'$.cancellation.state') IS NOT json_extract(NEW.payload,'$.cancellation.state'))
BEGIN
  INSERT OR IGNORE INTO agent_inbox(id,project_id,session_id,run_id,target,wake,kind,state,content,source,created_at)
  VALUES('task:'||NEW.id||':'||NEW.generation||':'||NEW.status||COALESCE(':'||json_extract(NEW.payload,'$.cancellation.state'),''),
    NEW.project_id,NEW.session_id,NEW.parent_run_id,'next-step',0,'task-result','ready',NEW.id,
    json_object('background',NEW.background),NEW.updated_at);
END;
--> statement-breakpoint
INSERT INTO agent_inbox(id,project_id,session_id,run_id,target,wake,kind,state,content,attachments,source,created_at)
SELECT id,project_id,session_id,run_id,target,wake,kind,state,content,attachments,source,created_at FROM (
  SELECT id,project_id,session_id,run_id,'next-step' AS target,1 AS wake,'user' AS kind,'ready' AS state,
    content,attachments,NULL AS source,created_at,rowid AS position FROM messages WHERE role='user' AND inherited=0
  UNION ALL
  SELECT i.id,r.project_id,r.session_id,r.id,
    CASE WHEN json_extract(i.source,'$.kind')='delegation' THEN 'next-turn' ELSE 'next-step' END,1,'agent','ready',
    i.content,NULL,i.source,i.created_at,i.rowid FROM agent_inputs i JOIN runs r ON i.run_id=r.id
  UNION ALL
  SELECT 'queue:'||request_id,project_id,session_id,target_run_id,
    CASE WHEN target_run_id IS NULL THEN 'next-turn' ELSE 'next-step' END,1,'queue',status,content,attachments,NULL,created_at,rowid
    FROM chat_queue WHERE status='pending'
  UNION ALL
  SELECT 'task:'||id||':'||generation||':'||status||COALESCE(':'||json_extract(payload,'$.cancellation.state'),''),
    project_id,session_id,parent_run_id,'next-step',0,'task-result','ready',id,NULL,json_object('background',background),updated_at,rowid
    FROM runs WHERE parent_run_id IS NOT NULL AND status IN ('done','failed','cancelled','paused') AND json_extract(payload,'$.inherited') IS NOT 1
) ORDER BY created_at,position;
