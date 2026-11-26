ALTER TABLE `model_calls` ADD `first_output_at` text;
--> statement-breakpoint
ALTER TABLE `model_calls` ADD `offload_images` integer;
--> statement-breakpoint
CREATE TRIGGER agent_step_end_unchanged_context AFTER INSERT ON agent_session_events
WHEN NEW.kind='context/unchanged'
BEGIN
  INSERT OR IGNORE INTO events(project_id,type,data,created_at)
  SELECT r.project_id,'step/end',json_object('runId',r.id,'sessionId',r.session_id,'turn',r.generation,
    'step',json_extract(c.request,'$.step'),'reason','context-unchanged'),NEW.created_at
  FROM runs r JOIN model_calls c ON c.run_id=r.id
  WHERE r.id=NEW.run_id AND c.id=NEW.reference AND c.status IN ('completed','failed')
    AND json_extract(c.request,'$.purpose')='compaction' AND json_extract(c.request,'$.turn')=r.generation
    AND json_extract(c.request,'$.step') IS NOT NULL;
END;
