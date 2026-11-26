ALTER TABLE runs ADD COLUMN agent_revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN background INTEGER NOT NULL DEFAULT 0 CHECK(background IN (0,1));
--> statement-breakpoint
CREATE TABLE agent_session_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  revision INTEGER NOT NULL CHECK(revision>0),
  kind TEXT NOT NULL,
  reference TEXT,
  patch TEXT NOT NULL CHECK(json_valid(patch)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,revision)
);
--> statement-breakpoint
CREATE INDEX runs_background_project ON runs(project_id,created_at,id) WHERE background=1;
--> statement-breakpoint
CREATE TRIGGER session_turn_open AFTER INSERT ON runs WHEN NEW.stage='agent' BEGIN
  INSERT INTO events(project_id,type,data,created_at)
    VALUES(NEW.project_id,'session/turn-start',json_object('runId',NEW.id,'parentRunId',NEW.parent_run_id,'generation',NEW.generation),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER session_turn_reopen AFTER UPDATE OF generation ON runs WHEN NEW.stage='agent' AND NEW.generation<>OLD.generation BEGIN
  INSERT INTO events(project_id,type,data,created_at)
    VALUES(NEW.project_id,'session/turn-start',json_object('runId',NEW.id,'parentRunId',NEW.parent_run_id,'generation',NEW.generation),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER session_turn_close AFTER UPDATE OF status ON runs
WHEN NEW.agent_role<>'media' AND (NEW.stage='agent' OR OLD.stage='agent') AND NEW.status<>OLD.status AND NEW.status IN ('done','failed','cancelled') BEGIN
  INSERT INTO events(project_id,type,data,created_at)
    VALUES(NEW.project_id,'session/turn-end',json_object('runId',NEW.id,'generation',NEW.generation,'status',NEW.status),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER session_job_registered AFTER INSERT ON runs WHEN NEW.background=1 BEGIN
  INSERT INTO events(project_id,type,data,created_at)
    VALUES(NEW.project_id,'job/registered',json_object('id',NEW.id,'runId',NEW.parent_run_id,'operation',json_extract(NEW.payload,'$.operation.name')),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER session_job_status AFTER UPDATE OF status,payload ON runs
WHEN NEW.background=1 AND (NEW.status<>OLD.status OR json_extract(NEW.payload,'$.cancellation.state') IS NOT json_extract(OLD.payload,'$.cancellation.state')) BEGIN
  INSERT INTO events(project_id,type,data,created_at)
    VALUES(NEW.project_id,CASE WHEN NEW.status IN ('done','failed','cancelled') THEN 'job/settled' ELSE 'job/status' END,
      json_object('id',NEW.id,'runId',NEW.parent_run_id,'status',NEW.status,'cancellation',json_extract(NEW.payload,'$.cancellation.state')),NEW.updated_at);
END;
