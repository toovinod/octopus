import { MIGRATION_LOCK_KEY, MigrationLockSettings, migrateCloudDatabase } from "./migrateCloudDatabase.ts";
import { makeEmptyTestDatabase, testServerUrl, withDatabaseUrl } from "./testCloudDatabase.ts";
import { ConfigProvider, Context, Duration, Effect, Layer, Option, Redacted } from "effect";
import { describe, expect, test } from "bun:test";
import { PgClient } from "@effect/sql-pg";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const serverUrl = Effect.runSync(testServerUrl);
const migrationCount = readdirSync(join(import.meta.dir, "..", "drizzle")).length;

const appliedMigrations = (url: Redacted.Redacted<string>) =>
	PgClient.PgClient.use(
		(sql) => sql<{ count: number }>`select count(*)::int as count from drizzle.__drizzle_migrations`,
	).pipe(
		Effect.map((rows) => rows[0]?.count),
		Effect.provide(PgClient.layer({ url })),
	);

describe.skipIf(Option.isNone(serverUrl))("migrateCloudDatabase", () => {
	test("two deploys migrating the same database at once both succeed and apply each migration once", async () => {
		const { results, applied } = await Effect.gen(function* () {
			const url = yield* makeEmptyTestDatabase(Option.getOrThrow(serverUrl));
			const results = yield* Effect.all([migrateCloudDatabase, migrateCloudDatabase], {
				concurrency: 2,
				mode: "result",
			}).pipe(withDatabaseUrl(url));
			return { results: results.map((result) => result._tag), applied: yield* appliedMigrations(url) };
		}).pipe(Effect.scoped, Effect.runPromise);
		expect(results).toEqual(["Success", "Success"]);
		expect(applied).toBe(migrationCount);
	});

	// A transaction-mode pooler such as Neon's hands each statement to any server connection,
	// so a session lock taken through it guards nothing.
	test("migrates through DATABASE_URL_UNPOOLED, never the pooled DATABASE_URL", async () => {
		const applied = await Effect.gen(function* () {
			const url = yield* makeEmptyTestDatabase(Option.getOrThrow(serverUrl));
			yield* migrateCloudDatabase.pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							DATABASE_URL: "postgres://nobody@127.0.0.1:1/unreachable",
							DATABASE_URL_UNPOOLED: Redacted.value(url),
						}),
					),
				),
			);
			return yield* appliedMigrations(url);
		}).pipe(Effect.scoped, Effect.runPromise);
		expect(applied).toBe(migrationCount);
	});

	test("gives up with MigrationLockTimeoutError when another deploy holds the lock past the wait", async () => {
		const result = await Effect.gen(function* () {
			const url = yield* makeEmptyTestDatabase(Option.getOrThrow(serverUrl));
			const holder = yield* Context.get(yield* Layer.build(PgClient.layer({ url })), PgClient.PgClient).reserve;
			yield* holder.executeRaw("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
			return yield* migrateCloudDatabase.pipe(
				withDatabaseUrl(url),
				Effect.provideService(MigrationLockSettings, { wait: Duration.seconds(1) }),
				Effect.flip,
			);
		}).pipe(Effect.scoped, Effect.runPromise);
		expect(result._tag).toBe("MigrationLockTimeoutError");
	});
});
