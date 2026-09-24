CREATE TABLE `cluster_leases` (
	`key` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cluster_leases_node_idx` ON `cluster_leases` (`node_id`);--> statement-breakpoint
CREATE TABLE `cluster_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`version` text NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL
);
