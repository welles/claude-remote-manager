CREATE TABLE `pull_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`created_by` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`merged_at` integer,
	`synced_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pull_requests_repository_number` ON `pull_requests` (`repository_id`,`number`);--> statement-breakpoint
CREATE INDEX `pull_requests_session` ON `pull_requests` (`session_id`);--> statement-breakpoint
ALTER TABLE `session_directories` ADD `pushed_commit` text;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `pushed_at` integer;