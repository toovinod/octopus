import { makeTestCloudDatabase, testServerUrl } from "./testCloudDatabase.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Exit, Option, Scope } from "effect";
import { PgClient } from "@effect/sql-pg";

const serverUrl = Effect.runSync(testServerUrl);

const insertWorkspace = (states: {
	readonly requestedState?: string;
	readonly observedState?: string;
	readonly sandboxProvider?: string;
}) =>
	PgClient.PgClient.use(
		(sql) => sql`insert into cloud_workspace
			(id, organization_id, created_by, repository_url, branch, base_branch, requested_state, observed_state, sandbox_provider)
			values (${Bun.randomUUIDv7()}, 'org_1', 'user_1', 'https://github.com/acme/app', 'feat/x', 'main',
				${states.requestedState ?? "running"}, ${states.observedState ?? "provisioning"}, ${states.sandboxProvider ?? "vercel"})`,
	);

describe.skipIf(Option.isNone(serverUrl))("cloud_workspace", () => {
	const scope = Effect.runSync(Scope.make());
	let run: <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) => Promise<A>;

	beforeAll(async () => {
		const url = await Effect.runPromise(makeTestCloudDatabase(Option.getOrThrow(serverUrl)).pipe(Scope.provide(scope)));
		run = (effect) => effect.pipe(Effect.provide(PgClient.layer({ url })), Effect.runPromise);
		await run(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`insert into "user" (id, name, email, created_at, updated_at) values ('user_1', 'Ada', 'ada@example.com', now(), now())`;
				yield* sql`insert into organization (id, name, slug, created_at) values ('org_1', 'Acme', 'acme', now())`;
			}),
		);
	});

	afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

	test("accepts the states and providers the code knows", async () => {
		expect((await run(Effect.result(insertWorkspace({}))))._tag).toBe("Success");
	});

	test("refuses a state or provider the code does not know, so a bad write cannot strand the worker", async () => {
		for (const states of [{ requestedState: "paused" }, { observedState: "booting" }, { sandboxProvider: "e2b" }]) {
			expect((await run(Effect.result(insertWorkspace(states))))._tag).toBe("Failure");
		}
	});
});
