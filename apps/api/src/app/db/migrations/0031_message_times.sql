CREATE TABLE `message_times` (
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `message_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
