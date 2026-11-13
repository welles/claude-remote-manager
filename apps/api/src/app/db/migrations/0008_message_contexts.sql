CREATE TABLE `message_contexts` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`origin` text NOT NULL,
	`references` text NOT NULL,
	`context_id` text,
	`context` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_contexts_session` ON `message_contexts` (`session_id`);