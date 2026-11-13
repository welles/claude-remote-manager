CREATE TABLE `previews` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`port` integer NOT NULL,
	`name` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`stopped_at` integer,
	`stopped_by` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `previews_active_port` ON `previews` (`port`) WHERE "previews"."stopped_at" is null;--> statement-breakpoint
CREATE INDEX `previews_session` ON `previews` (`session_id`);--> statement-breakpoint
CREATE INDEX `previews_label` ON `previews` (`label`);