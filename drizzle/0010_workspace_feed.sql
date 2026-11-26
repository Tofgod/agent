-- Compact change keys share the durable conversation cursor. They commit with the
-- affected records, so readers never have to infer changed rows from timestamps.
CREATE TRIGGER feed_project_update AFTER UPDATE ON projects BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.id,'feed:project',json_object('id',NEW.id),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_artifact_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:artifact',json_object('id',NEW.id),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_artifact_update AFTER UPDATE ON artifacts BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:artifact',json_object('id',NEW.id),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_message_insert AFTER INSERT ON messages BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:message',json_object('id',NEW.id),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_message_update AFTER UPDATE ON messages BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:message',json_object('id',NEW.id),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_run_insert AFTER INSERT ON runs BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:run',json_object('id',NEW.id),NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_run_update AFTER UPDATE OF status,stage,progress,label,error,payload,next_attempt_at,attempts,error_code,generation,input_version,result_text ON runs BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:run',json_object('id',NEW.id),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_reply_insert AFTER INSERT ON model_calls
WHEN json_extract(NEW.request,'$.purpose') IN ('creation','compaction') BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  SELECT project_id,'feed:reply',json_object('id',NEW.id),NEW.created_at FROM runs WHERE id=NEW.run_id;
END;
--> statement-breakpoint
CREATE TRIGGER feed_reply_update AFTER UPDATE OF status,visible_text,response ON model_calls
WHEN json_extract(NEW.request,'$.purpose') IN ('creation','compaction') BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  SELECT project_id,'feed:reply',json_object('id',NEW.id),COALESCE(NEW.settled_at,NEW.created_at) FROM runs WHERE id=NEW.run_id;
END;
--> statement-breakpoint
CREATE TRIGGER feed_step_insert AFTER INSERT ON execution_steps BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:step',json_object('id',NEW.seq),NEW.started_at);
END;
--> statement-breakpoint
CREATE TRIGGER feed_step_update AFTER UPDATE ON execution_steps BEGIN
  INSERT INTO events(project_id,type,data,created_at) VALUES(NEW.project_id,'feed:step',json_object('id',NEW.seq),COALESCE(NEW.finished_at,NEW.started_at));
END;
--> statement-breakpoint
CREATE TRIGGER feed_version_insert AFTER INSERT ON artifact_versions WHEN NEW.run_id IS NOT NULL BEGIN
  INSERT INTO events(project_id,type,data,created_at)
  SELECT project_id,'feed:changes',json_object('id',NEW.run_id),NEW.created_at FROM runs WHERE id=NEW.run_id;
END;
--> statement-breakpoint
CREATE INDEX events_message_anchor ON events(project_id,json_extract(data,'$.id'),id) WHERE type='message';
--> statement-breakpoint
CREATE INDEX events_request_anchor ON events(project_id,json_extract(data,'$.requestId'),id) WHERE type='request';
--> statement-breakpoint
CREATE INDEX events_step_anchor ON events(project_id,json_extract(data,'$.runId'),json_extract(data,'$.callId'),id) WHERE type='step';
