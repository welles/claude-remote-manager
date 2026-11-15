ALTER TABLE `session_directories` ADD `added_at` integer;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `added_by` text;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `addition_state` text;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `addition_error` text;--> statement-breakpoint
ALTER TABLE `session_directories` ADD `announce` integer DEFAULT false NOT NULL;