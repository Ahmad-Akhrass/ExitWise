CREATE TABLE `offboarding_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cases_owner_idx` ON `offboarding_cases` (`owner_id`);--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
