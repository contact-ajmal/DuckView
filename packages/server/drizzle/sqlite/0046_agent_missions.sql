ALTER TABLE `agent_sessions` ADD `mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `datasets` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `visibility` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_sessions_ws_idx` ON `agent_sessions` (`workspace_id`,`visibility`);