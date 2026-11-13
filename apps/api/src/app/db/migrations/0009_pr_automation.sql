CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `head_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autoclose` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_max_attempts` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_gave_up_at` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_ci_handled_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_reviews_after` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_last_run_at` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_last_trigger` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_running` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `close_handled_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `autoclosed_at` integer;