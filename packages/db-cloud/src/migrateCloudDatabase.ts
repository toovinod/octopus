import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Config, Effect } from "effect";
import { relations } from "./schema.ts";
import { join } from "node:path";

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "drizzle");

// Any fixed number works, as long as every instance uses the same one.
const MIGRATION_LOCK_KEY = 4_082_265_311;

// Two instances that deploy at once would both apply the same migration, and one fails halfway.
// A session advisory lock on a reserved connection makes the second wait, then find nothing to do.
const holdMigrationLock = Effect.gen(function* () {
	const connection = yield* (yield* PgClient.PgClient).reserve;
	yield* Effect.acquireRelease(connection.executeRaw("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]), () =>
		connection.executeRaw("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).pipe(Effect.ignore),
	);
});

export const migrateCloudDatabase = Effect.gen(function* () {
	yield* holdMigrationLock;
	const db = yield* PgDrizzle.makeWithDefaults({ relations });
	yield* migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	yield* Effect.log("Cloud database is up to date");
}).pipe(Effect.scoped, Effect.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })));

if (import.meta.main) {
	BunRuntime.runMain(migrateCloudDatabase);
}
