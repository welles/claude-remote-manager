ALTER TABLE `pull_requests` ADD `merge_conflict` integer;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `autofix_conflict_sha` text;