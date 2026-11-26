ALTER TABLE `background_job_output` ADD `channel` text DEFAULT 'stdout' NOT NULL;
--> statement-breakpoint
DROP TRIGGER job_output_bound;
--> statement-breakpoint
CREATE TRIGGER job_output_bound AFTER INSERT ON background_job_output
BEGIN
  DELETE FROM background_job_output WHERE job_id=NEW.job_id AND seq IN (
    SELECT seq FROM (
      SELECT seq,SUM(length(CAST(line AS BLOB))+1) OVER (ORDER BY seq DESC ROWS UNBOUNDED PRECEDING) AS bytes
      FROM background_job_output WHERE job_id=NEW.job_id
    ) WHERE bytes > (
      SELECT MIN(262144,MAX(1,COALESCE(json_extract(payload,'$.backgroundOutputLimitBytes'),262144))) FROM runs WHERE id=NEW.job_id
    )
  );
END;
--> statement-breakpoint
DROP TRIGGER job_output_started;
--> statement-breakpoint
CREATE TRIGGER job_output_started AFTER INSERT ON runs
WHEN NEW.background=1 AND json_extract(NEW.payload,'$.imported') IS NOT 1
BEGIN
  INSERT INTO background_job_output(job_id,line,created_at,channel) VALUES(NEW.id,NEW.label,NEW.created_at,'log');
END;
--> statement-breakpoint
DROP TRIGGER job_output_progress;
--> statement-breakpoint
CREATE TRIGGER job_output_progress AFTER UPDATE OF status,label,progress,error ON runs
WHEN NEW.background=1 AND (
  NEW.status<>OLD.status OR NEW.label<>OLD.label OR NEW.progress<>OLD.progress OR NEW.error IS NOT OLD.error
)
BEGIN
  INSERT INTO background_job_output(job_id,line,created_at,channel)
  VALUES(NEW.id,NEW.label || CASE WHEN NEW.progress>0 AND NEW.progress<100 THEN ' · '||NEW.progress||'%' ELSE '' END
    || CASE WHEN NEW.error IS NOT NULL THEN ' · '||substr(NEW.error,1,500) ELSE '' END,NEW.updated_at,'log');
END;
