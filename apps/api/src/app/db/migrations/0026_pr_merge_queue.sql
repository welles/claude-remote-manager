ALTER TABLE `pull_requests` ADD `merge_queued_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_queued_at` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_queue_position` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_queue_state` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_queue_group_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_queue_removed_sha` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_queue_removed_reason` text;