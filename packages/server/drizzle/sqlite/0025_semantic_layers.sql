CREATE TABLE `semantic_layers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`source` text NOT NULL,
	`yaml` text,
	`definition` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `semantic_layers_source_idx` ON `semantic_layers` (`workspace_id`,`source`);