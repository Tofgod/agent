ALTER TABLE `team_tasks` ADD `owner_is_lead` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE team_tasks SET owner_is_lead=1,owner_id=NULL
WHERE EXISTS(SELECT 1 FROM runs r WHERE r.id=team_tasks.owner_id
  AND r.project_id=team_tasks.project_id AND r.session_id=team_tasks.session_id
  AND r.parent_run_id IS NULL AND r.agent_role='main');
