ALTER TABLE `runs` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `error_code` text;--> statement-breakpoint
CREATE INDEX `runs_due_idx` ON `runs` (`status`,`next_attempt_at`,`lease_until`);