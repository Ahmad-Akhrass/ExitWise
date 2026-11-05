DELETE FROM `offboarding_cases` WHERE json_extract(`data`, '$.mode') = 'demo';--> statement-breakpoint
DELETE FROM `inactivity_reports` WHERE `mode` = 'demo';
