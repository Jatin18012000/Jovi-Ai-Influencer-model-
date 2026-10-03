ALTER TABLE `events` ADD `prev_hash` text;--> statement-breakpoint
ALTER TABLE `events` ADD `hash` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `reserved` integer DEFAULT false NOT NULL;