CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`directory` text,
	`logged_in` integer,
	`email` text,
	`organization` text,
	`subscription_type` text,
	`login_expires_at` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `account_id` text REFERENCES accounts(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `account_id` text;--> statement-breakpoint
INSERT INTO `accounts` (`id`, `provider`, `name`, `position`, `is_default`) VALUES ('main', 'claude', 'Claude', 0, 1);
