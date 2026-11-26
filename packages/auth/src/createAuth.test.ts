import { CLIENT_ADDRESS_HEADER, createAuth } from "./createAuth.ts";
import { authRelations } from "@repo/db-cloud/authSchema";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";

const placeholder = Redacted.make("test-secret-that-is-at-least-32-characters");
const oauthClient = { clientId: "test", clientSecret: placeholder };

const auth = createAuth({
	config: {
		baseUrl: "http://localhost:3001",
		webOrigin: "http://localhost:3000",
		secret: placeholder,
		databaseUrl: placeholder,
		github: oauthClient,
		google: oauthClient,
	},
	database: drizzle.mock({ relations: authRelations }),
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

describe("createAuth", () => {
	test("rate limits each client address the API resolved, whatever NODE_ENV is and X-Forwarded-For says", async () => {
		const statuses = await Promise.all(
			Array.from({ length: 101 }, (_, index) => statusFrom("203.0.113.1", `198.51.100.${index}`)),
		);
		expect(statuses.slice(0, 100).every((status) => status === 200)).toBe(true);
		expect(statuses[100]).toBe(429);
		expect(await statusFrom("203.0.113.2")).toBe(200);
	});
});
