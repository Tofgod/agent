CREATE TABLE studio_workflow_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL CHECK(json_valid(value)),
  run_id TEXT,
  generation INTEGER,
  created_at TEXT NOT NULL,
  event_seq INTEGER
);
CREATE INDEX studio_workflow_scope ON studio_workflow_events(project_id,session_id,owner,kind,seq DESC);
CREATE UNIQUE INDEX studio_goal_round_once ON studio_workflow_events(run_id) WHERE kind='goal/round';
CREATE TABLE studio_interactions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('question','plan','approval')),
  state TEXT NOT NULL CHECK(state IN ('waiting','pending','answered','dismissed','cancelled')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  answer TEXT CHECK(answer IS NULL OR json_valid(answer)),
  deadline INTEGER,
  hold_until INTEGER,
  UNIQUE(run_id,call_id)
);
CREATE INDEX studio_interaction_scope ON studio_interactions(project_id,session_id,state);
CREATE TRIGGER studio_workflow_feed AFTER INSERT ON studio_workflow_events BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'feed:workflow',json_object('id',NEW.session_id),NEW.created_at);
  UPDATE studio_workflow_events SET event_seq=last_insert_rowid() WHERE seq=NEW.seq;
END;
CREATE TRIGGER studio_interaction_created AFTER INSERT ON studio_interactions BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'feed:workflow',json_object('id',NEW.session_id),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER studio_interaction_changed AFTER UPDATE OF state ON studio_interactions BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'feed:workflow',json_object('id',NEW.session_id),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER studio_interaction_run_stopped AFTER UPDATE OF status,generation ON runs
WHEN NEW.status IN ('failed','paused','cancelled') OR NEW.generation<>OLD.generation BEGIN
  UPDATE studio_interactions SET state='cancelled'
  WHERE run_id=NEW.id AND generation=OLD.generation AND state='waiting';
END;

CREATE TRIGGER studio_approval_asked AFTER INSERT ON studio_interactions WHEN NEW.kind='approval' BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'approval/asked',json_object('id',NEW.id,'runId',NEW.run_id,'callId',NEW.call_id,
    'toolName',json_extract(NEW.data,'$.toolName'),'reason',json_extract(NEW.data,'$.questions[0].question')),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO events(project_id,type,data,created_at)
  SELECT NEW.project_id,'approval/decided',json_object('id',NEW.id,'runId',NEW.run_id,'callId',NEW.call_id,'outcome','rejected'),
    strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NEW.state='answered';
END;
CREATE TRIGGER studio_approval_decided AFTER UPDATE OF state ON studio_interactions
WHEN NEW.kind='approval' AND OLD.state='waiting' AND NEW.state IN ('answered','dismissed','cancelled') BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'approval/decided',json_object('id',NEW.id,'runId',NEW.run_id,'callId',NEW.call_id,
    'outcome',CASE WHEN NEW.state<>'answered' THEN 'cancelled'
      WHEN json_extract(NEW.answer,'$.answers[0].selected[0]')='允许一次' THEN 'allowed-once' ELSE 'rejected' END),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER studio_workflow_turn_opened AFTER INSERT ON runs
WHEN NEW.parent_run_id IS NULL AND NEW.intent='agent' AND json_extract(NEW.payload,'$.inherited') IS NOT 1 BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'feed:workflow',json_object('id',NEW.session_id),NEW.created_at);
END;
CREATE TRIGGER studio_workflow_turn_reopened AFTER UPDATE OF generation ON runs
WHEN NEW.generation<>OLD.generation AND NEW.parent_run_id IS NULL AND NEW.intent='agent' BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'feed:workflow',json_object('id',NEW.session_id),NEW.updated_at);
END;
