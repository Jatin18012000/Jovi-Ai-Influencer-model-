CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`production_id` text NOT NULL,
	`kind` text NOT NULL,
	`scene_id` text,
	`status` text NOT NULL,
	`status_reason` text,
	`provider` text,
	`provider_kind` text,
	`model` text,
	`request` text NOT NULL,
	`source_asset_ids` text NOT NULL,
	`location` text,
	`mime_type` text,
	`duration_seconds` real,
	`width` integer,
	`height` integer,
	`aspect_ratio` text,
	`provider_job_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`cost` text,
	`simulated` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`production_id`) REFERENCES `productions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `media_assets_production_idx` ON `media_assets` (`production_id`);--> statement-breakpoint
CREATE INDEX `media_assets_status_idx` ON `media_assets` (`status`);--> statement-breakpoint
CREATE TABLE `production_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`production_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`content` text NOT NULL,
	`agent_run_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`production_id`) REFERENCES `productions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `production_artifacts_kind_version_uq` ON `production_artifacts` (`production_id`,`kind`,`version`);--> statement-breakpoint
CREATE TABLE `productions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_planning_task_id` text,
	`idea_id` text NOT NULL,
	`idea` text NOT NULL,
	`production_context` text NOT NULL,
	`status` text NOT NULL,
	`identity_version` integer NOT NULL,
	`visual_identity_version` integer NOT NULL,
	`qa_status` text,
	`simulated` integer DEFAULT false NOT NULL,
	`approval_decision` text,
	`approved_by` text,
	`approval_note` text,
	`decided_at` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `productions_task_idx` ON `productions` (`task_id`);--> statement-breakpoint
CREATE INDEX `productions_status_idx` ON `productions` (`status`);--> statement-breakpoint
CREATE TABLE `visual_identity_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`is_active` integer NOT NULL,
	`profile` text NOT NULL,
	`approved_by` text NOT NULL,
	`change_summary` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visual_identity_version_uq` ON `visual_identity_versions` (`identity_id`,`version`);