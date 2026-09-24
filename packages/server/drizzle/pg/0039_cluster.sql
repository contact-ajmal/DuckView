CREATE TABLE "cluster_leases" (
	"key" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cluster_leases_node_idx" ON "cluster_leases" USING btree ("node_id");