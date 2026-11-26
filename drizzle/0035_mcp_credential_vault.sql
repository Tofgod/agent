CREATE TABLE `mcp_credentials` (
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`secret` text NOT NULL,
	PRIMARY KEY(`user_id`, `name`)
);
