ALTER TABLE runs ADD COLUMN lease_owner INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS session_job_wake_waiters AFTER UPDATE OF status,payload ON runs
WHEN NEW.background=1 AND (
  (NEW.status<>OLD.status AND NEW.status IN ('done','failed','cancelled','paused')) OR
  json_extract(NEW.payload,'$.cancellation.state') IS NOT json_extract(OLD.payload,'$.cancellation.state')
) BEGIN
  UPDATE runs SET next_attempt_at=0 WHERE project_id=NEW.project_id AND status='waiting'
    AND EXISTS(SELECT 1 FROM json_each(runs.payload,'$.agent.waitingFor') WHERE value=NEW.id);
END;
