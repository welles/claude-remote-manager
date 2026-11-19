CREATE TABLE `environment_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`file_name` text,
	`secret` integer NOT NULL,
	`value` text,
	`encrypted` text,
	`length` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_entries_environment_name` ON `environment_entries` (`environment_id`,`name`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`instructions` text,
	`setup_script` text,
	`model` text,
	`permission_mode` text,
	`repositories` text DEFAULT '[]' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environments_name_unique` ON `environments` (`name`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `environment_id` text REFERENCES environments(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `sessions` ADD `environment_setup_status` text DEFAULT 'none' NOT NULL;