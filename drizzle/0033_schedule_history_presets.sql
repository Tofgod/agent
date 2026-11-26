CREATE TABLE `session_preset_defaults` (
	`user_id` text PRIMARY KEY NOT NULL,
	`preset_id` text NOT NULL,
	FOREIGN KEY (`preset_id`) REFERENCES `session_presets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `studio_schedule_deliveries` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`schedule_id` text NOT NULL,
	`request_id` text NOT NULL,
	`at` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `studio_schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `studio_schedule_delivery_request` ON `studio_schedule_deliveries` (`schedule_id`,`request_id`);
--> statement-breakpoint
CREATE INDEX `studio_schedule_delivery_history` ON `studio_schedule_deliveries` (`schedule_id`,`seq`);
--> statement-breakpoint
INSERT INTO studio_schedule_deliveries(schedule_id,request_id,at,data)
SELECT id,json_extract(last,'$.requestId'),json_extract(last,'$.at'),last FROM studio_schedules
WHERE json_type(last,'$.requestId')='text' AND json_type(last,'$.at')='integer';
