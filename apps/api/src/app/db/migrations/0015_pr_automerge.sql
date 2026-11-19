ALTER TABLE `pull_requests` ADD `automerge` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `automerge_held_at` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `automerge_hold_reason` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `automerge_failed_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `automerge_failure` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `automerge_waiting` text;