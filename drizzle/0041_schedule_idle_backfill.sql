UPDATE studio_schedules AS schedule
SET last=json_set(last,'$.slotReleased',json('false'))
WHERE json_extract(schedule.data,'$.target.kind')='session'
  AND json_extract(schedule.last,'$.slotReleased') IS NULL AND (
  EXISTS(SELECT 1 FROM chat_queue q WHERE q.project_id=schedule.project_id
    AND q.request_id=json_extract(schedule.last,'$.requestId') AND q.status='pending')
  OR EXISTS(SELECT 1 FROM messages m JOIN runs r ON r.id=m.run_id
    WHERE m.project_id=schedule.project_id AND m.request_id=json_extract(schedule.last,'$.requestId')
      AND r.parent_run_id IS NULL AND r.status IN ('queued','running','waiting','paused'))
);
