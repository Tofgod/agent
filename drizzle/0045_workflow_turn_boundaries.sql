DROP TRIGGER studio_workflow_turn_opened;
DROP TRIGGER studio_workflow_turn_reopened;

CREATE TRIGGER studio_workflow_turn_started AFTER INSERT ON events
WHEN NEW.type='turn/start' BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  SELECT r.project_id,'feed:workflow',json_object('id',r.session_id),NEW.created_at
  FROM runs r WHERE r.id=json_extract(NEW.data,'$.runId') AND r.project_id=NEW.project_id
    AND r.parent_run_id IS NULL AND json_extract(r.payload,'$.inherited') IS NOT 1;
END;

ALTER TABLE chat_queue ADD COLUMN workflow_reply TEXT CHECK(workflow_reply IS NULL OR json_valid(workflow_reply));

CREATE TRIGGER studio_workflow_reply_promoted AFTER UPDATE OF status ON chat_queue
WHEN NEW.status='sent' AND OLD.status='pending' AND NEW.workflow_reply IS NOT NULL BEGIN
  UPDATE agent_inbox SET content=json_extract(NEW.workflow_reply,'$.content'),source=json_extract(NEW.workflow_reply,'$.source')
  WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND id IN (
    SELECT id FROM messages WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND request_id=NEW.request_id
  );
END;
