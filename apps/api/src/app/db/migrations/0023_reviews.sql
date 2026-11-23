ALTER TABLE `sessions` ADD `auto_review` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `review_model` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `review_effort` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_review_rounds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `reviewed_diff` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `review_id` text;