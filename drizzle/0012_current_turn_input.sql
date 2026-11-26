ALTER TABLE `chat_queue` ADD `target_run_id` text;--> statement-breakpoint
ALTER TABLE `chat_queue` ADD `turn_order` integer;--> statement-breakpoint
CREATE INDEX `chat_queue_current_turn` ON `chat_queue` (`target_run_id`,`status`,`turn_order`);--> statement-breakpoint
CREATE TRIGGER requeue_closed_turn_inputs AFTER UPDATE OF status ON runs
WHEN OLD.status<>NEW.status AND NEW.status IN ('done','failed','cancelled') BEGIN
  UPDATE chat_queue SET target_run_id=NULL,turn_order=NULL,version=version+1,updated_at=NEW.updated_at
  WHERE target_run_id=NEW.id AND project_id=NEW.project_id AND status='pending';
END;
