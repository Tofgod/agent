CREATE TABLE `fork_event_ancestry` (
	`event_id` integer PRIMARY KEY NOT NULL,
	`origin_event_id` integer NOT NULL,
	`root_run_id` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
WITH possible_runs AS (
  SELECT r.id AS copied_id, o.id AS original_id, r.project_id
  FROM runs r JOIN project_sessions p ON p.project_id=r.project_id AND p.id=r.session_id
  JOIN runs selected ON selected.id=p.fork_run_id AND selected.project_id=r.project_id
  JOIN runs o ON o.project_id=r.project_id AND o.id<>r.id AND o.parent_run_id IS NULL AND o.intent='agent'
    AND (o.id=json_extract(r.payload,'$.forkSource.runId')
      OR (json_type(r.payload,'$.forkSource') IS NULL AND o.session_id=selected.session_id AND o.created_at=r.created_at))
  WHERE r.parent_run_id IS NULL AND r.intent='agent' AND json_extract(r.payload,'$.inherited')=1
), pairs AS (
  SELECT copied_id,MIN(original_id) AS original_id,project_id FROM possible_runs
  GROUP BY copied_id,project_id HAVING COUNT(*)=1
), candidates AS (
  SELECT e.id AS event_id,b.id AS origin_event_id,p.original_id AS root_run_id
  FROM pairs p JOIN events e ON e.project_id=p.project_id
  LEFT JOIN messages m ON e.type='message' AND m.id=json_extract(e.data,'$.id')
  JOIN events b ON b.project_id=e.project_id AND b.type=e.type AND b.created_at=e.created_at
  LEFT JOIN messages n ON b.type='message' AND n.id=json_extract(b.data,'$.id')
  LEFT JOIN model_calls c ON c.id=json_extract(e.data,'$.requestId')
  LEFT JOIN model_calls d ON d.id=json_extract(b.data,'$.requestId')
  WHERE COALESCE(json_extract(e.data,'$.runId'),m.run_id)=p.copied_id
    AND COALESCE(json_extract(b.data,'$.runId'),n.run_id)=p.original_id
    AND (e.type IN ('request','reply') AND c.id IS NOT NULL AND d.id IS NOT NULL
      AND json_extract(c.request,'$.turn') IS json_extract(d.request,'$.turn')
      AND json_extract(c.request,'$.step') IS json_extract(d.request,'$.step')
      AND json_extract(c.request,'$.attempt') IS json_extract(d.request,'$.attempt')
      OR e.type='message' AND m.role IS n.role
      OR e.type='step' AND json_extract(e.data,'$.callId')=json_extract(b.data,'$.callId')
      OR e.type IN ('step/start','step/end','turn/start','turn/end') AND json_extract(e.data,'$.turn') IS json_extract(b.data,'$.turn')
        AND json_extract(e.data,'$.step') IS json_extract(b.data,'$.step')
        AND COALESCE(json_extract(e.data,'$.reason.reason'),'')<>'forked')
)
INSERT OR IGNORE INTO fork_event_ancestry(event_id,origin_event_id,root_run_id)
SELECT event_id,MIN(origin_event_id),root_run_id FROM candidates
GROUP BY event_id,root_run_id HAVING COUNT(*)=1;
