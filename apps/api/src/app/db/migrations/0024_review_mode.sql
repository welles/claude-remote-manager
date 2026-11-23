ALTER TABLE `sessions` ADD `review_mode` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `review_mode` = 'turn' WHERE `auto_review` = 1;