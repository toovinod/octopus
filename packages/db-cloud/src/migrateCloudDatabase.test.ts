import { makeEmptyTestDatabase, testServerUrl, withDatabaseUrl } from "./testCloudDatabase.ts";
import { migrateCloudDatabase } from "./migrateCloudDatabase.ts";
import { describe, expect, test } from "bun:test";
import { PgClient } from "@effect/sql-pg";
import { Effect, Option } from "effect";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const serverUrl = Effect.runSync(testServerUrl);
const migrationCount = readdirSync(join(import.meta.dir, "..", "drizzle")).length;

describe.skipIf(Option.isNone(serverUrl))("migrateCloudDatabase", () => {
	test("two deploys migrating the same database at once both succeed and apply each migration once", async () => {
		const { results, applied } = await Effect.gen(function* () {
			const url = yield* makeEmptyTestDatabase(Option.getOrThrow(serverUrl));
			const results = yield* Effect.all([migrateCloudDatabase, migrateCloudDatabase], {
				concurrency: 2,
				mode: "result",
			}).pipe(withDatabaseUrl(url));
			const rows = yield* PgClient.PgClient.use(
				(sql) => sql<{ count: number }>`select count(*)::int as count from drizzle.__drizzle_migrations`,
			).pipe(Effect.provide(PgClient.layer({ url })));
			return { results: results.map((result) => result._tag), applied: rows[0]?.count };
		}).pipe(Effect.scoped, Effect.runPromise);
		expect(results).toEqual(["Success", "Success"]);
		expect(applied).toBe(migrationCount);
	});
});
