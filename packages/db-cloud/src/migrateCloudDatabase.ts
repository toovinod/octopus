import { Config, Context, Duration, Effect, Schedule, Schema } from "effect";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { BunRuntime } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { relations } from "./schema.ts";
import { join } from "node:path";

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "drizzle");

// Any fixed number works, as long as every instance uses the same one.
export const MIGRATION_LOCK_KEY = 4_082_265_311;

export const MigrationLockSettings = Context.Reference<{
	// How long a deploy waits for another one to finish migrating before it gives up.
	readonly wait: Duration.Duration;
}>("octopus/db-cloud/migrateCloudDatabase/MigrationLockSettings", {
	defaultValue: () => ({ wait: Duration.minutes(5) }),
});

export class MigrationLockTimeoutError extends Schema.TaggedError<MigrationLockTimeoutError>()(
	"MigrationLockTimeoutError",
	{ message: Schema.String },
) {}

// Two instances that deploy at once would both apply the same migration, and one fails halfway.
// A session advisory lock on a reserved connection makes the second wait, then find nothing to do.
// The lock is only held through a direct connection, so this runs on DATABASE_URL_UNPOOLED.
const holdMigrationLock = Effect.gen(function* () {
	const { wait } = yield* MigrationLockSettings;
	const connection = yield* (yield* PgClient.PgClient).reserve;
	const tryLock = connection
		.executeValues("select pg_try_advisory_lock($1)", [MIGRATION_LOCK_KEY])
		.pipe(Effect.map((rows) => rows[0]?.[0] === true));
	yield* Effect.acquireRelease(
		tryLock.pipe(
			Effect.repeat({ schedule: Schedule.spaced(Duration.millis(500)), until: (acquired) => acquired }),
			Effect.timeoutOrElse({
				duration: wait,
				orElse: () =>
					Effect.fail(
						new MigrationLockTimeoutError({
							message: `Another deploy has held the migration lock for over ${Duration.format(wait)}. Check that its migration finished, then deploy again.`,
						}),
					),
			}),
		),
		() =>
			connection
				.executeRaw("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
				.pipe(
					Effect.catch((cause) =>
						Effect.logWarning("Could not release the migration lock; it ends with the connection", { cause }),
					),
				),
	);
});

export const migrateCloudDatabase = Effect.gen(function* () {
	yield* holdMigrationLock;
	const db = yield* PgDrizzle.makeWithDefaults({ relations });
	yield* migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	yield* Effect.log("Cloud database is up to date");
}).pipe(Effect.scoped, Effect.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL_UNPOOLED") })));

if (import.meta.main) {
	BunRuntime.runMain(migrateCloudDatabase);
}
