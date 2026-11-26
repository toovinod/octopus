CREATE TABLE `sessionAttachment` (
	`id` text PRIMARY KEY,
	`sessionId` text NOT NULL,
	`mediaType` text NOT NULL,
	CONSTRAINT `fk_sessionAttachment_sessionId_agentSession_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `agentSession`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `sessionAttachmentSessionIdIndex` ON `sessionAttachment` (`sessionId`);