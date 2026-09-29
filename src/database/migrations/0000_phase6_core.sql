CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_version` text NOT NULL,
	`task_id` text,
	`job_id` text,
	`correlation_id` text NOT NULL,
	`status` text NOT NULL,
	`input` text,
	`output` text,
	`context_summary` text,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `agent_runs_task_idx` ON `agent_runs` (`task_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_correlation_idx` ON `agent_runs` (`correlation_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`capabilities` text NOT NULL,
	`allowed_tools` text NOT NULL,
	`permission_level` text NOT NULL,
	`model_requirements` text NOT NULL,
	`cost_class` text NOT NULL,
	`risk_level` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`decision_type` text NOT NULL,
	`status` text NOT NULL,
	`objective` text NOT NULL,
	`context` text NOT NULL,
	`options` text NOT NULL,
	`selected_action` text,
	`reasoning_summary` text NOT NULL,
	`confidence` real NOT NULL,
	`decision_agent` text NOT NULL,
	`models_used` text NOT NULL,
	`evaluation` text,
	`next_actions` text,
	`correlation_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_task_idx` ON `decisions` (`task_id`);--> statement-breakpoint
CREATE INDEX `decisions_created_idx` ON `decisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`decision_id` text,
	`subject_type` text NOT NULL,
	`method` text NOT NULL,
	`result` text NOT NULL,
	`correlation_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluations_decision_idx` ON `evaluations` (`decision_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`timestamp` text NOT NULL,
	`source` text NOT NULL,
	`entity_id` text,
	`payload` text NOT NULL,
	`schema_version` integer NOT NULL,
	`correlation_id` text,
	`causation_id` text,
	`sequence` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`event_type`);--> statement-breakpoint
CREATE INDEX `events_correlation_idx` ON `events` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `events_entity_idx` ON `events` (`entity_id`);--> statement-breakpoint
CREATE INDEX `events_sequence_idx` ON `events` (`sequence`);--> statement-breakpoint
CREATE TABLE `identity_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`version` integer NOT NULL,
	`profile` text NOT NULL,
	`change_summary` text NOT NULL,
	`approved_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `jovi_identity`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identity_versions_identity_version_uq` ON `identity_versions` (`identity_id`,`version`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`last_error` text,
	`run_after` text NOT NULL,
	`locked_at` text,
	`correlation_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_task_idx` ON `jobs` (`task_id`);--> statement-breakpoint
CREATE TABLE `jovi_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`creator_name` text NOT NULL,
	`active_version` integer NOT NULL,
	`profile` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`importance` real NOT NULL,
	`confidence` real NOT NULL,
	`source` text NOT NULL,
	`tags` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_items_type_key_uq` ON `memory_items` (`type`,`key`);--> statement-breakpoint
CREATE INDEX `memory_items_importance_idx` ON `memory_items` (`importance`);--> statement-breakpoint
CREATE TABLE `model_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`task_id` text,
	`job_id` text,
	`agent_run_id` text,
	`correlation_id` text NOT NULL,
	`routing_category` text NOT NULL,
	`routing_reason` text NOT NULL,
	`attempt` integer NOT NULL,
	`is_fallback` integer NOT NULL,
	`fallback_from` text,
	`status` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`latency_ms` integer NOT NULL,
	`estimated_api_cost` real,
	`execution_cost_type` text NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `model_runs_correlation_idx` ON `model_runs` (`correlation_id`);--> statement-breakpoint
CREATE INDEX `model_runs_task_idx` ON `model_runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`is_default` integer DEFAULT false NOT NULL,
	`capabilities` text NOT NULL,
	`pricing` text,
	`last_checked_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `models_provider_idx` ON `models` (`provider`);--> statement-breakpoint
CREATE TABLE `strategy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`objective` text NOT NULL,
	`status` text NOT NULL,
	`content` text NOT NULL,
	`rationale` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`activated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strategy_versions_version_uq` ON `strategy_versions` (`version`);--> statement-breakpoint
CREATE INDEX `strategy_versions_status_idx` ON `strategy_versions` (`status`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`input` text,
	`result` text,
	`error` text,
	`correlation_id` text NOT NULL,
	`parent_task_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_correlation_idx` ON `tasks` (`correlation_id`);