CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`clone_url` text,
	`default_branch` text,
	`local_path` text NOT NULL,
	`setup_script` text,
	`github_repository_id` integer,
	`github_installation_id` integer,
	`cloned_at` integer,
	`fetched_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_owner_name` ON `repositories` (`owner`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_local_path` ON `repositories` (`local_path`);--> statement-breakpoint
ALTER TABLE `session_directories` ADD `kind` text DEFAULT 'directory' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `repository_id` text REFERENCES repositories(id);--> statement-breakpoint
ALTER TABLE `session_directories` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `base_commit` text;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `state` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `setup_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `session_directories_session_repository` ON `session_directories` (`session_id`,`repository_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `pending_message` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_slug_unique` ON `sessions` (`slug`);--> statement-breakpoint
-- The working directory becomes directory 0 of each session; the existing
-- additional directories move up by one (via negative positions, so the
-- unique index on (session_id, position) holds after every row).
UPDATE `session_directories` SET `position` = -(`position` + 2);--> statement-breakpoint
UPDATE `session_directories` SET `position` = -`position` - 1;--> statement-breakpoint
INSERT INTO `session_directories` (`session_id`, `position`, `path`) SELECT `id`, 0, `cwd` FROM `sessions`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `cwd`;