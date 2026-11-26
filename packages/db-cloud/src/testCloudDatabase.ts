import { Config, ConfigProvider, Context, Effect, Layer, Redacted } from "effect";
import { migrateCloudDatabase } from "./migrateCloudDatabase.ts";
import { PgClient } from "@effect/sql-pg";

// Tests that need Postgres run only when TEST_DATABASE_URL names a server where this user may
// create databases, such as the docker-compose one: postgres://octopus:octopus@localhost:5432/octopus
export const testServerUrl = Config.option(Config.Redacted("TEST_DATABASE_URL"));

// A new empty database on the test server, dropped when the scope closes, so test files never share rows.
export const makeEmptyTestDatabase = Effect.fn("makeEmptyTestDatabase")(function* (
	serverUrl: Redacted.Redacted<string>,
) {
	const name = `octopus_test_${Bun.randomUUIDv7().replaceAll("-", "_")}`;
	const admin = Context.get(yield* Layer.build(PgClient.layer({ url: serverUrl })), PgClient.PgClient);
	yield* Effect.acquireRelease(admin.unsafe(`create database "${name}"`), () =>
		admin.unsafe(`drop database "${name}" with (force)`).pipe(Effect.orDie),
	);
	const url = new URL(Redacted.value(serverUrl));
	url.pathname = `/${name}`;
	return Redacted.make(url.toString());
});

// Runs an effect that reads DATABASE_URL or DATABASE_URL_UNPOOLED against the given database.
export const withDatabaseUrl =
	(url: Redacted.Redacted<string>) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({ DATABASE_URL: Redacted.value(url), DATABASE_URL_UNPOOLED: Redacted.value(url) }),
				),
			),
		);

export const makeTestCloudDatabase = Effect.fn("makeTestCloudDatabase")(function* (
	serverUrl: Redacted.Redacted<string>,
) {
	const url = yield* makeEmptyTestDatabase(serverUrl);
	yield* migrateCloudDatabase.pipe(withDatabaseUrl(url));
	return url;
});
