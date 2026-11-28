ALTER TABLE `sessions` ADD `review_engine` text;--> statement-breakpoint
UPDATE `sessions` SET `review_engine` = 'claude-code' WHERE `review_model` IS NOT NULL;
