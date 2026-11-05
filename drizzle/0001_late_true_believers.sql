CREATE TABLE `inactivity_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`mode` text NOT NULL,
	`data` text NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inactivity_owner_idx` ON `inactivity_reports` (`owner_id`);