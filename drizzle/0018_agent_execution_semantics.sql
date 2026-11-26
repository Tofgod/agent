ALTER TABLE `execution_steps` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `execution_steps` ADD `call_index` integer;--> statement-breakpoint
ALTER TABLE `execution_steps` ADD `provider_call_id` text;--> statement-breakpoint
ALTER TABLE `execution_steps` ADD `output_ref` text;--> statement-breakpoint
ALTER TABLE `execution_steps` ADD `output_images` text;--> statement-breakpoint
CREATE INDEX `execution_steps_output_ref` ON `execution_steps` (`project_id`,`output_ref`);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_turn_boundary ON events(project_id,type,json_extract(data,'$.runId'),json_extract(data,'$.turn'))
  WHERE type='turn/start' OR type='turn/end';
--> statement-breakpoint
CREATE UNIQUE INDEX agent_step_boundary ON events(project_id,type,json_extract(data,'$.runId'),json_extract(data,'$.turn'),json_extract(data,'$.step'))
  WHERE type='step/start' OR type='step/end';
--> statement-breakpoint
CREATE TRIGGER agent_turn_start AFTER UPDATE OF status,generation ON runs
WHEN NEW.status='running' AND NEW.agent_role<>'media' AND NEW.intent IN ('agent','compact')
  AND (OLD.status<>'running' OR OLD.generation<>NEW.generation)
BEGIN
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'turn/start',json_object('runId',NEW.id,'sessionId',NEW.session_id,'turn',NEW.generation),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER agent_turn_end AFTER UPDATE OF status ON runs
WHEN NEW.status IN ('done','failed','cancelled') AND OLD.status NOT IN ('done','failed','cancelled')
  AND NEW.agent_role<>'media' AND NEW.intent IN ('agent','compact')
BEGIN
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  SELECT NEW.project_id,'step/end',json_set(e.data,'$.reason','turn-ended'),NEW.updated_at
  FROM events e WHERE e.project_id=NEW.project_id AND e.type='step/start'
    AND json_extract(e.data,'$.runId')=NEW.id AND json_extract(e.data,'$.turn')=NEW.generation
  ORDER BY e.id;
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  VALUES(NEW.project_id,'turn/end',json_object('runId',NEW.id,'sessionId',NEW.session_id,'turn',NEW.generation,
    'reason',json(CASE
      WHEN NEW.status='cancelled' THEN json_object('kind','aborted','reason','cancelled')
      WHEN NEW.error_code='DEPENDENCY_BLOCKED' THEN json_object('kind','blocked','code',NEW.error_code)
      WHEN NEW.error_code='MODEL_TRUNCATED' OR (NEW.status='done' AND json_extract(NEW.payload,'$.agent.outputLimited')=1) THEN json_object('kind','max-tokens')
      WHEN NEW.status='failed' THEN json_object('kind','error','code',COALESCE(NEW.error_code,'EXECUTION_ERROR'),'message',NEW.error)
      ELSE json_object('kind','completed') END)),NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER agent_step_start AFTER INSERT ON model_calls
WHEN json_extract(NEW.request,'$.attempt')=1
BEGIN
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  SELECT r.project_id,'step/end',json_set(e.data,'$.reason','attempt-ended'),NEW.created_at
  FROM runs r JOIN events e ON e.project_id=r.project_id AND e.type='step/start'
  WHERE r.id=NEW.run_id AND r.status='running' AND json_extract(e.data,'$.runId')=r.id
    AND json_extract(e.data,'$.turn')=r.generation
    AND json_extract(e.data,'$.step')<json_extract(NEW.request,'$.step')
  ORDER BY e.id;
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  SELECT project_id,'step/start',json_object('runId',id,'sessionId',session_id,'turn',generation,
    'step',json_extract(NEW.request,'$.step')),NEW.created_at FROM runs WHERE id=NEW.run_id AND status='running';
END;
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
        AND json_extract(r.payload,'$.agent.toolIndex')>=COALESCE(json_array_length(c.response,'$.tool_calls'),0)));
END;
