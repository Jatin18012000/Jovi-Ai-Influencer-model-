CREATE TABLE `audit_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`hash` text NOT NULL,
	`pruned_events` integer NOT NULL,
	`pruned_before` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `api_credentials` ADD `expires_at` text;