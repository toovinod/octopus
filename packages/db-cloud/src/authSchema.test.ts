import { makeEmptyTestDatabase, makeTestCloudDatabase, testServerUrl, withDatabaseUrl } from "./testCloudDatabase.ts";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { migrateCloudDatabase } from "./migrateCloudDatabase.ts";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Effect, Option, type Redacted } from "effect";
import { describe, expect, test } from "bun:test";
import { PgClient } from "@effect/sql-pg";
import { relations } from "./schema.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const serverUrl = Effect.runSync(testServerUrl);
const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "drizzle");

const withSql = (url: Redacted.Redacted<string>) => Effect.provide(PgClient.layer({ url }));

const insertOrgAndUser = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	yield* sql`insert into "user" (id, name, email, created_at, updated_at) values ('user_1', 'Ada', 'ada@example.com', now(), now())`;
	yield* sql`insert into organization (id, name, slug, created_at) values ('org_1', 'Acme', 'acme', now())`;
});

const insertMember = (id: string, role: string, createdAt: string) =>
	PgClient.PgClient.use(
		(sql) =>
			sql`insert into member (id, organization_id, user_id, role, created_at) values (${id}, 'org_1', 'user_1', ${role}, ${createdAt}::timestamp)`,
	);

const membersOf = PgClient.PgClient.use(
	(sql) => sql<{ id: string; role: string }>`select id, role from member where user_id = 'user_1' order by id`,
);

// Applies the migrations up to, but not including, the first one whose folder name contains `before`.
const migrateUpTo = (url: Redacted.Redacted<string>, before: string) =>
	Effect.gen(function* () {
		const folder = mkdtempSync(join(tmpdir(), "octopus-migrations-"));
		yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(folder, { recursive: true })));
		const all = readdirSync(MIGRATIONS_FOLDER).sort();
		for (const name of all.slice(
			0,
			all.findIndex((name) => name.includes(before)),
		)) {
			cpSync(join(MIGRATIONS_FOLDER, name), join(folder, name), { recursive: true });
		}
		const db = yield* PgDrizzle.makeWithDefaults({ relations });
		yield* migrate(db, { migrationsFolder: folder });
	}).pipe(withSql(url));

// Runs queries against a new, fully migrated database.
const inMigratedDatabase = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) =>
	Effect.gen(function* () {
		const url = yield* makeTestCloudDatabase(Option.getOrThrow(serverUrl));
		return yield* effect.pipe(withSql(url));
	}).pipe(Effect.scoped, Effect.runPromise);

const insertAccount = (id: string) =>
	PgClient.PgClient.use(
		(sql) =>
			sql`insert into account (id, account_id, provider_id, user_id, created_at, updated_at) values (${id}, '12345', 'github', 'user_1', now(), now())`,
	);

describe.skipIf(Option.isNone(serverUrl))("auth schema", () => {
	test("a user is a member of an org at most once, so removing the member removes their access", async () => {
		const result = await Effect.gen(function* () {
			const url = yield* makeTestCloudDatabase(Option.getOrThrow(serverUrl));
			return yield* Effect.gen(function* () {
				yield* insertOrgAndUser;
				yield* insertMember("member_1", "member", "2026-01-01");
				return yield* Effect.result(insertMember("member_2", "admin", "2026-01-02"));
			}).pipe(withSql(url));
		}).pipe(Effect.scoped, Effect.runPromise);
		expect(result._tag).toBe("Failure");
	});

	// Inserts one user's duplicate rows into a database migrated up to the dedupe, then finishes migrating.
	const membersAfterDedupe = (rows: ReadonlyArray<readonly [id: string, role: string, createdAt: string]>) =>
		Effect.gen(function* () {
			const url = yield* makeEmptyTestDatabase(Option.getOrThrow(serverUrl));
			yield* migrateUpTo(url, "dedupe_members");
			yield* Effect.gen(function* () {
				yield* insertOrgAndUser;
				for (const [id, role, createdAt] of rows) yield* insertMember(id, role, createdAt);
			}).pipe(withSql(url));
			yield* migrateCloudDatabase.pipe(withDatabaseUrl(url));
			return yield* membersOf.pipe(withSql(url));
		}).pipe(Effect.scoped, Effect.runPromise);

	test("upgrading a database with duplicate members keeps each user's highest role, so an owner is never demoted", async () => {
		const members = await membersAfterDedupe([
			["member_a", "member", "2026-01-01"],
			["member_b", "admin", "2026-01-02"],
			["member_c", "owner", "2026-01-03"],
		]);
		expect(members).toEqual([{ id: "member_c", role: "owner" }]);
	});

	test("upgrading reads a combined role such as 'member,owner' as its highest part", async () => {
		const members = await membersAfterDedupe([
			["member_a", "admin", "2026-01-01"],
			["member_b", "member, owner", "2026-01-02"],
		]);
		expect(members).toEqual([{ id: "member_b", role: "member, owner" }]);
	});

	test("upgrading keeps the oldest of duplicate members with the same role", async () => {
		const members = await membersAfterDedupe([
			["member_b", "admin", "2026-01-02"],
			["member_a", "admin", "2026-01-01"],
		]);
		expect(members).toEqual([{ id: "member_a", role: "admin" }]);
	});

	test("one GitHub or Google identity links to one account row, so sign-in always finds the same user", async () => {
		const result = await inMigratedDatabase(
			Effect.gen(function* () {
				yield* insertOrgAndUser;
				yield* insertAccount("account_1");
				return yield* Effect.result(insertAccount("account_2"));
			}),
		);
		expect(result._tag).toBe("Failure");
	});

	test("organization.slug has one unique index, not two identical ones", async () => {
		const indexes = await inMigratedDatabase(
			PgClient.PgClient.use(
				(sql) => sql<{ indexname: string }>`select indexname from pg_indexes
					where tablename = 'organization' and indexdef like 'CREATE UNIQUE INDEX%(slug)'`,
			),
		);
		expect(indexes).toHaveLength(1);
	});

	test("auth timestamps, which have no time zone, read back the instant written whatever the server's zone", async () => {
		const expiresAt = new Date("2026-03-01T12:00:00.000Z");
		const rows = await Effect.gen(function* () {
			const url = yield* makeEmptyTestDatabase(Option.getOrThrow(serverUrl));
			// Docker's and Neon's Postgres already run in UTC, where the bug cannot show.
			yield* PgClient.PgClient.use(
				(sql) => sql`DO $$ BEGIN
					EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Kolkata');
				END $$`,
			).pipe(withSql(url));
			yield* migrateCloudDatabase.pipe(withDatabaseUrl(url));
			return yield* Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* insertOrgAndUser;
				yield* sql`insert into session (id, token, user_id, expires_at, created_at, updated_at)
					values ('session_1', 'token', 'user_1', ${expiresAt}, now(), now())`;
				return yield* sql<{
					expiresAt: Date;
					expired: boolean;
				}>`select expires_at as "expiresAt", expires_at < now() as expired
					from session where id = 'session_1'`;
			}).pipe(withSql(url));
		}).pipe(Effect.scoped, Effect.runPromise);
		expect(rows).toEqual([{ expiresAt, expired: true }]);
	});

	// Rows written before a constraint existed cannot be fixed safely by a migration, so it must stop
	// and say what to fix, not fail on a bare index or check error.
	const upgradeFailureWith = <E>(rows: Effect.Effect<unknown, E, PgClient.PgClient>) =>
		Effect.gen(function* () {
			const url = yield* makeEmptyTestDatabase(Option.getOrThrow(serverUrl));
			yield* migrateUpTo(url, "preflight_constraints");
			yield* Effect.gen(function* () {
				yield* insertOrgAndUser;
				yield* rows;
			}).pipe(withSql(url));
			return Bun.inspect(yield* migrateCloudDatabase.pipe(withDatabaseUrl(url), Effect.flip));
		}).pipe(Effect.scoped, Effect.runPromise);

	test("upgrading stops with a clear error when one identity is linked to two accounts", async () => {
		const failure = await upgradeFailureWith(
			Effect.gen(function* () {
				yield* insertAccount("account_1");
				yield* insertAccount("account_2");
			}),
		);
		expect(failure).toContain("Identities linked to more than one account row: 1");
	});

	test("upgrading stops with a clear error when a cloud workspace has a state the code does not know", async () => {
		const failure = await upgradeFailureWith(
			PgClient.PgClient.use(
				(sql) => sql`insert into cloud_workspace
					(id, organization_id, created_by, repository_url, branch, base_branch, requested_state, observed_state, sandbox_provider)
					values ('workspace_1', 'org_1', 'user_1', 'https://github.com/acme/app', 'feat/x', 'main', 'paused', 'running', 'vercel')`,
			),
		);
		expect(failure).toContain("cloud_workspace rows with a state or sandbox provider the code does not know: 1");
	});
});
