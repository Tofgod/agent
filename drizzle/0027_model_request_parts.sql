CREATE TABLE `model_request_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `model_calls` ADD `request_header_id` text REFERENCES model_request_parts(id);