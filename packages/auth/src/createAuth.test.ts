import { makeTestCloudDatabase, testServerUrl } from "@repo/db-cloud/testCloudDatabase";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLIENT_ADDRESS_HEADER, createAuth } from "./createAuth.ts";
import { Effect, Exit, Option, Redacted, Scope } from "effect";
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
	const auth = createAuth({
		config: { ...configFor("http://localhost:3001"), databaseUrl },
		database: drizzle({ client, relations: authRelations }),
		sendInvitation: () => Promise.resolve(),
		publishMembershipEvent: () => Promise.resolve(),
	});
	const statusFrom = (address: string, forwardedFor = address) =>
		auth
			.handler(
				new Request("http://localhost:3001/api/auth/ok", {
					headers: { [CLIENT_ADDRESS_HEADER]: address, "x-forwarded-for": forwardedFor },
				}),
			)
			.then((response) => response.status);
	return { statusFrom, sql: client, close: () => client.close() };
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
});
