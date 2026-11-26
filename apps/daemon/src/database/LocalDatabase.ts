import { Context, Duration, Effect, FileSystem, Layer, Schema } from "effect";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as SQLiteBunDrizzle from "drizzle-orm/effect-sqlite-bun";
import { embeddedMigrations } from "./embeddedMigrations.ts";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { migrate } from "drizzle-orm/sqlite-core/effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { SqlError } from "effect/sql/SqlError";
import { join } from "node:path";

export type LocalDrizzle = SQLiteBunDrizzle.EffectSQLiteBunDatabase;

type DriverError = EffectDrizzleQueryError | SqlError;

const isRetryableDriverError = (error: DriverError) => {
	const sqlError = error instanceof SqlError ? error : error.cause;
	return sqlError instanceof SqlError && sqlError.isRetryable;
};

export class LocalDatabaseError extends Schema.TaggedError<LocalDatabaseError>()("LocalDatabaseError", {
	// A busy or locked database is retryable. Everything else is permanent.
	retryable: Schema.Boolean,
	cause: Schema.Defect(),
}) {}

export class DatabaseIntegrityError extends Schema.TaggedError<DatabaseIntegrityError>()("DatabaseIntegrityError", {
	// The tables holding rows whose parent row is missing.
	tables: Schema.Array(Schema.String),
}) {
	override get message() {
		return `A database migration left rows in ${this.tables.join(", ")} pointing at rows that do not exist. Octopus did not start, so nothing more changed. Restore the database from a backup or report this.`;
	}
}

export const DATABASE_FILE_NAME = "octopus.db";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

// SQLite creates the -wal and -shm files with the process umask; only the owner may read them.
const restrictDatabaseFiles = Effect.gen(function* () {
	const { dataDir } = yield* DaemonConfig;
	const fs = yield* FileSystem.FileSystem;
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = join(dataDir, `${DATABASE_FILE_NAME}${suffix}`);
		if (yield* fs.exists(file)) {
			yield* fs.chmod(file, PRIVATE_FILE_MODE);
		}
	}
});

// SQLite ignores the foreign_keys pragma inside a transaction, and drizzle runs the migrations in one. With
// keys on, a migration that rebuilds a table would DROP it and cascade the delete into every child row.
// Keys stay off until the migrations ran and every row still has its parent.
export const runMigrations = Effect.fn("runMigrations")(function* (migrations: Array<MigrationMeta>) {
	const client = yield* SqliteClient.SqliteClient;
	const db = yield* SQLiteBunDrizzle.makeWithDefaults();
	yield* client`PRAGMA foreign_keys = OFF`;
	yield* migrate(migrations, db._.session);
	const violations = yield* client<{ readonly table: string }>`PRAGMA foreign_key_check`;
	if (violations.length > 0) {
		return yield* new DatabaseIntegrityError({ tables: [...new Set(violations.map(({ table }) => table))] });
	}
	// The client keeps one connection, so this pragma holds for every query.
	yield* client`PRAGMA foreign_keys = ON`;
});

export class LocalDatabase extends Context.Service<
	LocalDatabase,
	{
		// Domain checks return values from `run` and fail outside it, so `run` only fails with driver errors.
		readonly query: <A>(
			run: (db: LocalDrizzle) => Effect.Effect<A, DriverError>,
		) => Effect.Effect<A, LocalDatabaseError>;
	}
>()("octopus/daemon/database/LocalDatabase") {
	static readonly layer = Layer.effect(
		LocalDatabase,
		Effect.gen(function* () {
			const db = yield* SQLiteBunDrizzle.makeWithDefaults();
			const client = yield* SqliteClient.SqliteClient;
			yield* runMigrations(embeddedMigrations());
			yield* restrictDatabaseFiles;
			// Runs after every layer that writes has closed and before the connection closes, so the
			// WAL is folded into the database file and truncated.
			yield* Effect.addFinalizer(() =>
				client`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
					Effect.andThen(Effect.logDebug("Checkpointed the database")),
					Effect.catch((cause) => Effect.logWarning("Could not checkpoint the database on shutdown", cause)),
				),
			);

			return LocalDatabase.of({
				query: (run) =>
					run(db).pipe(
						Effect.mapError(
							(cause) =>
								new LocalDatabaseError({
									retryable: isRetryableDriverError(cause),
									cause,
								}),
						),
					),
			});
		}),
	).pipe(
		Layer.provide(
			Layer.unwrap(
				Effect.gen(function* () {
					const { dataDir } = yield* DaemonConfig;
					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(dataDir, {
						recursive: true,
						mode: PRIVATE_DIRECTORY_MODE,
					});
					// mkdir leaves an existing folder's mode alone, so tighten it explicitly.
					yield* fs.chmod(dataDir, PRIVATE_DIRECTORY_MODE);
					// SqliteClient turns on WAL by default.
					return SqliteClient.layer({
						filename: join(dataDir, DATABASE_FILE_NAME),
						busyTimeout: Duration.seconds(5),
					});
				}),
			),
		),
	);
}
