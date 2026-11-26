CREATE TABLE project_deletions (
  project_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER delete_project_records BEFORE DELETE ON projects BEGIN
  INSERT INTO project_deletions(project_id,user_id) VALUES(OLD.id,OLD.user_id);

  -- The inspector deduplicates request headers and messages across projects.
  DELETE FROM model_request_parts WHERE id IN (
    WITH removed_calls AS (
      SELECT c.request_header_id,c.request FROM model_calls c JOIN runs r ON r.id=c.run_id
      WHERE r.project_id=OLD.id AND c.request_header_id IS NOT NULL
    ), candidates AS (
      SELECT request_header_id AS id FROM removed_calls
      UNION SELECT p.value FROM removed_calls c,json_each(c.request,'$.messageParts') p WHERE p.type='text'
    ), retained_calls AS (
      SELECT c.request_header_id,c.request FROM model_calls c JOIN runs r ON r.id=c.run_id
      WHERE r.project_id<>OLD.id AND c.request_header_id IS NOT NULL
    )
    SELECT id FROM candidates
    EXCEPT SELECT request_header_id FROM retained_calls
    EXCEPT SELECT p.value FROM retained_calls c,json_each(c.request,'$.messageParts') p WHERE p.type='text'
  );
  DELETE FROM model_calls WHERE run_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM agent_inputs WHERE run_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM agent_session_events WHERE run_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM archived_fork_checkpoints WHERE run_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM deliveries WHERE run_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM execution_steps WHERE project_id=OLD.id;
  DELETE FROM fork_event_ancestry WHERE root_run_id IN (SELECT id FROM runs WHERE project_id=OLD.id)
    OR event_id IN (SELECT id FROM events WHERE project_id=OLD.id)
    OR origin_event_id IN (SELECT id FROM events WHERE project_id=OLD.id);
  DELETE FROM tool_receipts WHERE run_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM background_job_output WHERE job_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM background_job_reads WHERE job_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM background_job_truncation WHERE job_id IN (SELECT id FROM runs WHERE project_id=OLD.id);
  DELETE FROM background_wake_budget WHERE project_id=OLD.id;
  DELETE FROM chat_queue WHERE project_id=OLD.id;
  DELETE FROM agent_inbox WHERE project_id=OLD.id;
  DELETE FROM messages WHERE project_id=OLD.id;
  DELETE FROM disk_workspace_files WHERE project_id=OLD.id;
  DELETE FROM disk_workspaces WHERE project_id=OLD.id;
  DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE project_id=OLD.id);
  DELETE FROM artifacts WHERE project_id=OLD.id;
  DELETE FROM events WHERE project_id=OLD.id;
  DELETE FROM studio_schedules WHERE project_id=OLD.id;
  DELETE FROM session_reference_snapshots WHERE project_id=OLD.id;
  DELETE FROM session_preset_bindings WHERE project_id=OLD.id;
  DELETE FROM project_sessions WHERE project_id=OLD.id;
  DELETE FROM team_modes WHERE project_id=OLD.id;
  DELETE FROM team_tasks WHERE project_id=OLD.id;
  DELETE FROM runs WHERE project_id=OLD.id;
END;
