ALTER TABLE `execution_steps` ADD `dispatched_at` text;
--> statement-breakpoint
UPDATE execution_steps SET dispatched_at=started_at;
--> statement-breakpoint
CREATE VIEW pending_agent_tools AS
SELECT r.id AS run_id,c.id AS request_id,CAST(item.key AS INTEGER) AS call_index,
  json_extract(item.value,'$.id') AS call_id,item.value AS call
FROM runs r JOIN model_calls c ON c.run_id=r.id
JOIN json_each(c.response,'$.tool_calls') item
WHERE c.status='completed' AND json_extract(c.request,'$.purpose')='creation'
  AND (json_extract(c.request,'$.turn') IS NULL OR json_extract(c.request,'$.turn')=r.generation)
  AND c.id IN (json_extract(r.payload,'$.agent.toolRequestId'),json_extract(r.payload,'$.agent.pendingRequest.id'))
  AND json_extract(r.payload,'$.imported') IS NOT 1 AND json_extract(r.payload,'$.inherited') IS NOT 1
  AND NOT EXISTS (SELECT 1 FROM execution_steps s WHERE s.run_id=r.id AND s.call_id=json_extract(item.value,'$.id'));
--> statement-breakpoint
DROP TRIGGER agent_step_end;
--> statement-breakpoint
CREATE TRIGGER agent_step_end AFTER INSERT ON agent_session_events
WHEN NEW.kind IN ('model/accepted','tools/settled','context/compacted','tasks/waiting','checkpoint') AND NEW.reference IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  SELECT r.project_id,'step/end',json_object('runId',r.id,'sessionId',r.session_id,'turn',r.generation,
    'step',json_extract(c.request,'$.step')),NEW.created_at FROM runs r JOIN model_calls c ON c.run_id=r.id
  WHERE r.id=NEW.run_id AND c.status='completed' AND json_extract(c.request,'$.turn')=r.generation
    AND json_extract(c.request,'$.step') IS NOT NULL
    AND (NEW.kind='context/compacted' AND c.id=NEW.reference
      OR (c.id=json_extract(r.payload,'$.agent.toolRequestId')
        AND json_extract(r.payload,'$.agent.pendingRequest') IS NULL
        AND json_extract(r.payload,'$.agent.toolIndex')>=COALESCE(json_array_length(c.response,'$.tool_calls'),0)))
    AND NOT EXISTS (SELECT 1 FROM pending_agent_tools p WHERE p.run_id=r.id AND p.request_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM execution_steps s WHERE s.run_id=r.id AND s.request_id=c.id AND s.status='running');
END;
--> statement-breakpoint
DROP TRIGGER agent_step_end_after_receipt;
--> statement-breakpoint
CREATE TRIGGER agent_step_end_after_receipt AFTER INSERT ON events
WHEN NEW.type='step' AND json_extract(NEW.data,'$.stepSeq') IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  SELECT r.project_id,'step/end',json_object('runId',r.id,'sessionId',r.session_id,'turn',r.generation,
    'step',json_extract(c.request,'$.step')),NEW.created_at
  FROM execution_steps s JOIN runs r ON r.id=s.run_id JOIN model_calls c ON c.id=s.request_id AND c.run_id=r.id
  WHERE s.seq=json_extract(NEW.data,'$.stepSeq') AND s.status<>'running'
    AND c.status='completed' AND json_extract(c.request,'$.turn')=r.generation
    AND json_extract(c.request,'$.step') IS NOT NULL AND c.id=json_extract(r.payload,'$.agent.toolRequestId')
    AND json_extract(r.payload,'$.agent.pendingRequest') IS NULL
    AND json_extract(r.payload,'$.agent.toolIndex')>=COALESCE(json_array_length(c.response,'$.tool_calls'),0)
    AND NOT EXISTS (SELECT 1 FROM pending_agent_tools p WHERE p.run_id=r.id AND p.request_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM execution_steps pending WHERE pending.run_id=r.id AND pending.request_id=c.id AND pending.status='running');
END;
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
  VALUES(NEW.project_id,'turn/end',json_object('runId',NEW.id,'sessionId',NEW.session_id,'turn',NEW.generation,
    'reason',json(CASE
      WHEN NEW.status='cancelled' THEN json_object('kind','aborted','reason','cancelled')
      WHEN NEW.error_code='DEPENDENCY_BLOCKED' THEN json_object('kind','blocked','code',NEW.error_code)
      WHEN NEW.error_code='MODEL_TRUNCATED' OR (NEW.status='done' AND EXISTS(SELECT 1 FROM model_calls c
        WHERE c.run_id=NEW.id AND c.error_code='MODEL_TRUNCATED' AND json_extract(c.request,'$.turn')=NEW.generation
          AND json_extract(c.request,'$.purpose')='creation')) THEN json_object('kind','max-tokens')
      WHEN NEW.status='failed' THEN json_object('kind','error','code',COALESCE(NEW.error_code,'EXECUTION_ERROR'),'message',NEW.error)
      ELSE json_object('kind','completed') END)),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
