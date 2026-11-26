DROP INDEX "organization_slug_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_organizationId_userId_uidx" ON "member" ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "cloud_workspace" ADD CONSTRAINT "cloud_workspace_requested_state_check" CHECK ("requested_state" in ('running', 'stopped', 'archived'));--> statement-breakpoint
ALTER TABLE "cloud_workspace" ADD CONSTRAINT "cloud_workspace_observed_state_check" CHECK ("observed_state" in ('provisioning', 'running', 'sleeping', 'stopped', 'failed', 'unknown'));--> statement-breakpoint
ALTER TABLE "cloud_workspace" ADD CONSTRAINT "cloud_workspace_sandbox_provider_check" CHECK ("sandbox_provider" in ('vercel'));