CREATE TABLE `api_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_credentials_name_uq` ON `api_credentials` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_credentials_token_hash_uq` ON `api_credentials` (`token_hash`);