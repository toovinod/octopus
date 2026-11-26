import { leaveOrganizationHook, membershipHooks, sessionHooks } from "./membershipHooks.ts";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import type { InvitationEmailInput } from "@repo/email/invitationEmail";
import { type Auth, type AuthContext, betterAuth } from "better-auth";
import type { MembershipEvent } from "./MembershipEvents.ts";
import { schemaConstraints } from "./schemaConstraints.ts";
import * as authSchema from "@repo/db-cloud/authSchema";
import type { AuthConfig } from "./AuthConfig.ts";
import { Redacted } from "effect";

export const DESKTOP_CLIENT_ID = "octopus-desktop";

// The API sets this to the client's address on every request, replacing any value the client sent.
// Better Auth reads only this header, so rate limits never trust a forwarded header directly.
export const CLIENT_ADDRESS_HEADER = "x-octopus-client-address";

export interface CreateAuthInput {
	readonly config: typeof AuthConfig.Service;
	readonly database: Parameters<typeof drizzleAdapter>[0];
	readonly sendInvitation: (input: InvitationEmailInput) => Promise<void>;
	readonly publishMembershipEvent: (event: MembershipEvent) => Promise<void>;
}

// Better Auth is promise based, so it gets plain callbacks. The Auth layer bridges them to Effect.
export const createAuth = ({
	config,
	database,
	sendInvitation,
	publishMembershipEvent,
}: CreateAuthInput): Pick<Auth, "handler" | "options"> & {
	readonly $context: Promise<Pick<AuthContext, "authCookies">>;
} =>
	betterAuth({
		baseURL: config.baseUrl,
		secret: Redacted.value(config.secret),
		trustedOrigins: [config.webOrigin],
		database: drizzleAdapter(database, { provider: "pg", schema: authSchema }),
		// Sign-in tokens from GitHub and Google are secrets, so they are encrypted at rest.
		account: { encryptOAuthTokens: true },
		socialProviders: {
			github: {
				clientId: config.github.clientId,
				clientSecret: Redacted.value(config.github.clientSecret),
			},
			google: {
				clientId: config.google.clientId,
				clientSecret: Redacted.value(config.google.clientSecret),
			},
		},
		hooks: { after: leaveOrganizationHook(publishMembershipEvent) },
		databaseHooks: sessionHooks(publishMembershipEvent),
		// Better Auth turns rate limiting on only when NODE_ENV is production, and the API does not set it.
		// Counts live in Postgres, so every API instance enforces one shared limit per client.
		rateLimit: { enabled: true, storage: "database" },
		// The web app and the API must share one site (app.example.com and api.example.com), so Better
		// Auth's default SameSite=Lax cookies reach the API from the web app, also in Safari and with
		// third-party cookies blocked. SameSite=None broke both. Cookies are Secure when the API is on https.
		advanced: { ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] } },
		plugins: [
			organization({
				sendInvitationEmail: ({ id, email, organization, inviter, invitation }) =>
					sendInvitation({
						to: email,
						organizationName: organization.name,
						inviterName: inviter.user.name,
						acceptUrl: `${config.webOrigin}/invite?id=${encodeURIComponent(id)}`,
						// Resending an invitation moves its expiry, so a deliberate resend still gets through.
						idempotencyKey: `invitation/${id}/${invitation.expiresAt.toISOString()}`,
					}),
				organizationHooks: membershipHooks(publishMembershipEvent),
			}),
			deviceAuthorization({
				verificationUri: `${config.webOrigin}/device`,
				validateClient: (clientId) => clientId === DESKTOP_CLIENT_ID,
			}),
			// The desktop app sends the session token from the device flow as a bearer token.
			bearer(),
			schemaConstraints(),
		],
	});
