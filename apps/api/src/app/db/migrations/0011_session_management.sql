CREATE TABLE `deleted_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`repositories` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`anchor` text NOT NULL,
	`hash` text NOT NULL,
	`text` text NOT NULL,
	`folded` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_documents_unique` ON `search_documents` (`session_id`,`anchor`,`hash`);--> statement-breakpoint
CREATE TABLE `search_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`indexed_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_usage_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`sdk_session_id` text,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_creation_input_tokens` integer NOT NULL,
	`cache_read_input_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_usage_records`("id", "session_id", "sdk_session_id", "model", "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cost_usd", "created_at") SELECT "id", "session_id", "sdk_session_id", "model", "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cost_usd", "created_at" FROM `usage_records`;--> statement-breakpoint
DROP TABLE `usage_records`;--> statement-breakpoint
ALTER TABLE `__new_usage_records` RENAME TO `usage_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `usage_records_session` ON `usage_records` (`session_id`);--> statement-breakpoint
CREATE INDEX `usage_records_created_at` ON `usage_records` (`created_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `archived_at` integer;--> statement-breakpoint
CREATE VIRTUAL TABLE `search_index` USING fts5(`folded`, content='search_documents', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER `search_documents_ai` AFTER INSERT ON `search_documents` BEGIN
	INSERT INTO `search_index`(rowid, `folded`) VALUES (new.`id`, new.`folded`);
END;--> statement-breakpoint
CREATE TRIGGER `search_documents_ad` AFTER DELETE ON `search_documents` BEGIN
	INSERT INTO `search_index`(`search_index`, rowid, `folded`) VALUES ('delete', old.`id`, old.`folded`);
END;--> statement-breakpoint
CREATE TRIGGER `search_documents_au` AFTER UPDATE ON `search_documents` BEGIN
	INSERT INTO `search_index`(`search_index`, rowid, `folded`) VALUES ('delete', old.`id`, old.`folded`);
	INSERT INTO `search_index`(rowid, `folded`) VALUES (new.`id`, new.`folded`);
END;
