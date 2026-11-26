import { makeTestCloudDatabase, testServerUrl } from "@repo/db-cloud/testCloudDatabase";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Exit, Option, Redacted, Schema, Scope } from "effect";
import { CLIENT_ADDRESS_HEADER, createAuth } from "./createAuth.ts";
import type { MembershipEvent } from "./MembershipEvents.ts";
import { authRelations } from "@repo/db-cloud/authSchema";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { SQL } from "bun";

const placeholder = Redacted.make("test-secret-that-is-at-least-32-characters");
const oauthClient = { clientId: "test", clientSecret: placeholder };
const serverUrl = Effect.runSync(testServerUrl);

const configFor = (baseUrl: string) => ({
	baseUrl,
	webOrigin: "http://localhost:3000",
	secret: placeholder,
	databaseUrl: placeholder,
	github: oauthClient,
	google: oauthClient,
});

const sessionCookieFor = async (baseUrl: string) => {
	const auth = createAuth({
		config: configFor(baseUrl),
		database: drizzle.mock({ relations: authRelations }),
		sendInvitation: () => Promise.resolve(),
		publishMembershipEvent: () => Promise.resolve(),
	});
	return (await auth.$context).authCookies.sessionToken.attributes;
};

describe("session cookie", () => {
	// The web app and the API are deployed on one site, such as app.example.com and api.example.com.
	test("is SameSite=Lax, which Safari and third-party cookie blocking still send within one site", async () => {
		expect((await sessionCookieFor("https://api.octopus.test")).sameSite).toBe("lax");
	});

	test("is Secure when the API is served over https", async () => {
		expect((await sessionCookieFor("https://api.octopus.test")).secure).toBe(true);
	});
});

// One API instance: its own Better Auth and its own connection pool.
const startInstance = (databaseUrl: Redacted.Redacted<string>) => {
	const client = new SQL(Redacted.value(databaseUrl));
	const events: Array<MembershipEvent> = [];
	const auth = createAuth({
		config: { ...configFor("http://localhost:3001"), databaseUrl },
		database: drizzle({ client, relations: authRelations }),
		sendInvitation: () => Promise.resolve(),
		publishMembershipEvent: (event) => Promise.resolve(void events.push(event)),
	});
	const statusFrom = (address: string, forwardedFor = address) =>
		auth
			.handler(
				new Request("http://localhost:3001/api/auth/ok", {
					headers: { [CLIENT_ADDRESS_HEADER]: address, "x-forwarded-for": forwardedFor },
				}),
			)
			.then((response) => response.status);
	// Calls an endpoint from the web app as a signed-in user, as the desktop app does with its bearer token.
	const post = (path: string, token: string, body: object = {}) =>
		auth.handler(
			new Request(`http://localhost:3001/api/auth${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Origin: "http://localhost:3000",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		);
	return { statusFrom, post, events, sql: client, close: () => client.close() };
};

// Inserts a user with one live session per name and returns the session tokens.
const signIn = async (sql: SQL, userId: string, sessionNames: ReadonlyArray<string>) => {
	await sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		values (${userId}, ${userId}, ${`${userId}@example.com`}, true, now(), now())`;
	for (const name of sessionNames) {
		await sql`insert into session (id, token, user_id, expires_at, created_at, updated_at)
			values (${name}, ${`${name}-token`}, ${userId}, now() + interval '1 day', now(), now())`;
	}
	return sessionNames.map((name) => `${name}-token`);
};

describe.skipIf(Option.isNone(serverUrl))("createAuth", () => {
	const scope = Effect.runSync(Scope.make());
	let first: ReturnType<typeof startInstance>;
	let second: ReturnType<typeof startInstance>;

	beforeAll(async () => {
		const databaseUrl = await Effect.runPromise(
			makeTestCloudDatabase(Option.getOrThrow(serverUrl)).pipe(Scope.provide(scope)),
		);
		first = startInstance(databaseUrl);
		second = startInstance(databaseUrl);
	});

	afterAll(async () => {
		await Promise.all([first.close(), second.close()]);
		await Effect.runPromise(Scope.close(scope, Exit.void));
	});

	test("rate limits each client address the API resolved, whatever NODE_ENV is and X-Forwarded-For says", async () => {
		const statuses = [];
		for (let index = 0; index < 101; index++) {
			statuses.push(await first.statusFrom("203.0.113.1", `198.51.100.${index}`));
		}
		expect(statuses.slice(0, 100).every((status) => status === 200)).toBe(true);
		expect(statuses[100]).toBe(429);
		expect(await first.statusFrom("203.0.113.2")).toBe(200);
	});

	test("keeps the count in Postgres, so separate API instances share one limit per client", async () => {
		expect(await first.statusFrom("203.0.113.3")).toBe(200);
		expect(await second.statusFrom("203.0.113.3")).toBe(200);
		const rows = await first.sql`select count from rate_limit where key = ${"203.0.113.3|/ok"}`;
		expect(rows).toEqual([{ count: 2 }]);
	});

	test("publishes sessionRevoked when a user signs out", async () => {
		const [token = ""] = await signIn(first.sql, "user_signout", ["session_signout"]);
		expect((await first.post("/sign-out", token)).status).toBe(200);
		expect(first.events).toContainEqual({
			_tag: "sessionRevoked",
			userId: "user_signout",
			sessionId: "session_signout",
		});
	});

	test("publishes sessionRevoked for every session a user revokes at once", async () => {
		const [token = ""] = await signIn(first.sql, "user_revoke", ["session_revoke_a", "session_revoke_b"]);
		expect((await first.post("/revoke-sessions", token)).status).toBe(200);
		expect(first.events.filter((event) => event._tag === "sessionRevoked" && event.userId === "user_revoke")).toEqual([
			{ _tag: "sessionRevoked", userId: "user_revoke", sessionId: "session_revoke_a" },
			{ _tag: "sessionRevoked", userId: "user_revoke", sessionId: "session_revoke_b" },
		]);
	});

	test("publishes organizationDeleted when an owner deletes the org", async () => {
		const [token = ""] = await signIn(first.sql, "user_owner", ["session_owner"]);
		const created = await first.post("/organization/create", token, { name: "Doomed", slug: "doomed" });
		const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await created.json());
		expect((await first.post("/organization/delete", token, { organizationId: id })).status).toBe(200);
		expect(first.events).toContainEqual({ _tag: "organizationDeleted", organizationId: id });
	});

	// Better Auth refuses a second invitation to a pending address, but two sent at once both get through.
	test("accepting two pending invitations to one org makes the user a member once", async () => {
		const [ownerToken = ""] = await signIn(first.sql, "user_inviter", ["session_inviter"]);
		const created = await first.post("/organization/create", ownerToken, { name: "Acme", slug: "acme-invites" });
		const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await created.json());
		const [inviteeToken = ""] = await signIn(first.sql, "user_invitee", ["session_invitee"]);
		for (const invitationId of ["invitation_a", "invitation_b"]) {
			await first.sql`insert into invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
				values (${invitationId}, ${id}, 'user_invitee@example.com', 'member', 'pending', now() + interval '1 day', now(), 'user_inviter')`;
		}
		expect(
			(await first.post("/organization/accept-invitation", inviteeToken, { invitationId: "invitation_a" })).status,
		).toBe(200);
		expect(
			(await first.post("/organization/accept-invitation", inviteeToken, { invitationId: "invitation_b" })).ok,
		).toBe(false);
		expect(await first.sql`select count(*)::int as count from member where user_id = 'user_invitee'`).toEqual([
			{ count: 1 },
		]);
	});
});
