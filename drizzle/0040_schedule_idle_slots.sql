CREATE TRIGGER schedule_idle_after_run
AFTER UPDATE OF status ON runs
WHEN NEW.parent_run_id IS NULL AND NEW.status IN ('done','failed','cancelled')
BEGIN
  UPDATE studio_schedules SET last=json_set(last,'$.slotReleased',json('true'))
  WHERE project_id=NEW.project_id AND json_extract(last,'$.sessionId')=NEW.session_id
    AND json_extract(last,'$.slotReleased')=0
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.project_id=NEW.project_id AND r.session_id=NEW.session_id
      AND r.parent_run_id IS NULL AND r.status IN ('queued','running','waiting','paused'))
    AND NOT EXISTS(SELECT 1 FROM chat_queue q WHERE q.project_id=NEW.project_id AND q.session_id=NEW.session_id AND q.status='pending');
END;
--> statement-breakpoint
CREATE TRIGGER schedule_idle_after_queue
AFTER UPDATE OF status ON chat_queue
WHEN OLD.status='pending' AND NEW.status<>'pending'
BEGIN
  UPDATE studio_schedules SET last=json_set(last,'$.slotReleased',json('true'))
  WHERE project_id=NEW.project_id AND json_extract(last,'$.sessionId')=NEW.session_id
    AND json_extract(last,'$.slotReleased')=0
    AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.project_id=NEW.project_id AND r.session_id=NEW.session_id
      AND r.parent_run_id IS NULL AND r.status IN ('queued','running','waiting','paused'))
    AND NOT EXISTS(SELECT 1 FROM chat_queue q WHERE q.project_id=NEW.project_id AND q.session_id=NEW.session_id AND q.status='pending');
END;
