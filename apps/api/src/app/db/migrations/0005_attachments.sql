CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`message_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`name` text,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`session_id`,`message_id`);