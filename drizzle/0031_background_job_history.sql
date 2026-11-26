CREATE TABLE `background_job_truncation` (
	`job_id` text PRIMARY KEY NOT NULL,
	`through_seq` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `background_job_reads` ADD `observed_terminal` text;
--> statement-breakpoint
UPDATE background_job_reads SET observed_terminal=terminal WHERE terminal IS NOT NULL;
--> statement-breakpoint
-- The previous trigger kept 511 rows and did not record the removed cursor.
-- Recover a cutoff when a full surviving window no longer contains the creation entry.
INSERT INTO background_job_truncation(job_id,through_seq)
SELECT o.job_id, MIN(o.seq)-1 FROM background_job_output o JOIN runs r ON r.id=o.job_id
GROUP BY o.job_id HAVING COUNT(*)=511 AND MIN(o.created_at)>r.created_at AND MIN(o.seq)>1;
--> statement-breakpoint
CREATE TRIGGER job_output_truncated AFTER DELETE ON background_job_output
BEGIN
  INSERT INTO background_job_truncation(job_id,through_seq) VALUES(OLD.job_id,OLD.seq)
  ON CONFLICT(job_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq);
END;
--> statement-breakpoint
DROP TRIGGER job_output_started;
--> statement-breakpoint
CREATE TRIGGER job_output_started AFTER INSERT ON runs
WHEN NEW.background=1 AND json_extract(NEW.payload,'$.imported') IS NOT 1
BEGIN
  INSERT INTO background_job_output(job_id,line,created_at) VALUES(NEW.id,NEW.label,NEW.created_at);
END;
