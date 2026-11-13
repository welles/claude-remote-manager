CREATE TABLE `shown_files` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool_use_id` text,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`caption` text,
	`kind` text NOT NULL,
	`media_type` text NOT NULL,
	`language` text,
	`size` integer NOT NULL,
	`snapshot` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shown_files_session` ON `shown_files` (`session_id`);