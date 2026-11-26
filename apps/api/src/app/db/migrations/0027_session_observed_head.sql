ALTER TABLE `session_directories` ADD `observed_head` text;--> statement-breakpoint
UPDATE `session_directories` SET `observed_head` = '';