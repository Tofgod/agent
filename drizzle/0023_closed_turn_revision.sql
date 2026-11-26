ALTER TABLE `tool_receipts` ADD `concludes_turn` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP TRIGGER agent_turn_end;
--> statement-breakpoint
CREATE TRIGGER agent_turn_end AFTER UPDATE OF status,lease_until ON runs
WHEN NEW.status IN ('done','failed','cancelled') AND NEW.agent_role<>'media' AND NEW.intent IN ('agent','compact')
  AND NOT EXISTS(SELECT 1 FROM model_calls c WHERE c.run_id=NEW.id AND c.status='started')
  AND NOT EXISTS(SELECT 1 FROM execution_steps s WHERE s.run_id=NEW.id AND s.status='running')
  AND NOT EXISTS(SELECT 1 FROM pending_agent_tools p WHERE p.run_id=NEW.id)
BEGIN
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  SELECT NEW.project_id,'step/end',json_set(e.data,'$.reason','turn-ended'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM events e WHERE e.project_id=NEW.project_id AND e.type='step/start'
    AND json_extract(e.data,'$.runId')=NEW.id AND json_extract(e.data,'$.turn')=NEW.generation
  ORDER BY e.id;
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'turn/end',json_object('runId',NEW.id,'sessionId',NEW.session_id,'turn',NEW.generation,'agentRevision',NEW.agent_revision,
    'reason',json(CASE
      WHEN NEW.error_code='SESSION_INTERRUPTED' THEN json_object('kind','interrupted')
      WHEN NEW.status='cancelled' THEN json_object('kind','aborted','reason','cancelled')
      WHEN NEW.error_code='DEPENDENCY_BLOCKED' THEN json_object('kind','blocked','code',NEW.error_code)
      WHEN NEW.error_code='MODEL_TRUNCATED' OR (NEW.status='done' AND EXISTS(SELECT 1 FROM model_calls c
        WHERE c.run_id=NEW.id AND c.error_code='MODEL_TRUNCATED' AND json_extract(c.request,'$.turn')=NEW.generation
          AND json_extract(c.request,'$.purpose')='creation')) THEN json_object('kind','max-tokens')
      WHEN NEW.status='failed' THEN json_object('kind','error','code',COALESCE(NEW.error_code,'EXECUTION_ERROR'),'message',NEW.error)
      ELSE json_object('kind','completed') END)),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
