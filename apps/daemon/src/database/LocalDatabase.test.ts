import { agentSession, project, sessionAttachment, sessionEvent, workspace } from "./schema.ts";
import { DATABASE_FILE_NAME, LocalDatabase, runMigrations } from "./LocalDatabase.ts";
import { testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { embeddedMigrations } from "./embeddedMigrations.ts";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, test } from "bun:test";
import { count, sql } from "drizzle-orm";
import { join } from "node:path";

const withDatabase = <A, E>(program: Effect.Effect<A, E, LocalDatabase>, dataDir: string) =>
	program.pipe(Effect.provide(LocalDatabase.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer]))));

const run = <A, E>(program: (dataDir: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* program(yield* fs.makeTempDirectoryScoped());
	}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

describe("LocalDatabase", () => {
	test("migrates a new file with WAL, NORMAL sync, foreign keys and a 5 second busy timeout", async () => {
		const pragmas = await run((dataDir) =>
			withDatabase(
				LocalDatabase.use((database) =>
					database.query((db) =>
						Effect.all([
							db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`),
							db.get<{ synchronous: number }>(sql`PRAGMA synchronous`),
							db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`),
							db.get<{ timeout: number }>(sql`PRAGMA busy_timeout`),
							db.select().from(project),
						]),
					),
				),
				dataDir,
			),
		);
		expect(pragmas).toEqual([{ journal_mode: "wal" }, { synchronous: 1 }, { foreign_keys: 1 }, { timeout: 5000 }, []]);
	});

	test("reopening an existing file applies no migration twice", async () => {
		const rows = await run((dataDir) =>
			Effect.gen(function* () {
				const insert = LocalDatabase.use((database) =>
					database.query((db) =>
						db.insert(project).values({
							id: "p1",
							name: "repo",
							path: "/repo",
							defaultBranch: "main",
							createdAt: "2026-01-01T00:00:00.000Z",
						}),
					),
				);
				yield* withDatabase(insert, dataDir);
				return yield* withDatabase(
					LocalDatabase.use((database) => database.query((db) => db.select().from(project))),
					dataDir,
				);
			}),
		);
		expect(rows.map((row) => row.id)).toEqual(["p1"]);
	});

	test("keeps the data dir and database files private to the user", async () => {
		const modes = await run((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const freshDir = join(tempDir, "fresh");
				const openDir = join(tempDir, "open");
				yield* fs.makeDirectory(openDir, { mode: 0o755 });
				yield* fs.chmod(openDir, 0o755);
				const modeOf = (path: string) => Effect.map(fs.stat(path), (info) => info.mode & 0o777);
				const modesIn = (dataDir: string) =>
					Effect.all([
						modeOf(dataDir),
						modeOf(join(dataDir, DATABASE_FILE_NAME)),
						modeOf(join(dataDir, `${DATABASE_FILE_NAME}-wal`)),
						modeOf(join(dataDir, `${DATABASE_FILE_NAME}-shm`)),
					]);
				return yield* Effect.all([withDatabase(modesIn(freshDir), freshDir), withDatabase(modesIn(openDir), openDir)]);
			}),
		);
		expect(modes).toEqual([
			[0o700, 0o600, 0o600, 0o600],
			[0o700, 0o600, 0o600, 0o600],
		]);
	});

	test("a migration that rebuilds a parent table keeps its child rows", async () => {
		const workspaceColumns =
			"`id`, `projectId`, `name`, `kind`, `path`, `branch`, `baseBranch`, `status`, `pullRequestUrl`, `fromFork`, `createdAt`, `archivedAt`";
		// What drizzle-kit writes to change a column: a new table, a copy, then DROP TABLE on the old one.
		const rebuild: MigrationMeta = {
			sql: [
				"PRAGMA foreign_keys=OFF;",
				"CREATE TABLE `__new_workspace` (`id` text PRIMARY KEY, `projectId` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE, `name` text NOT NULL, `kind` text NOT NULL, `path` text NOT NULL, `branch` text NOT NULL, `baseBranch` text NOT NULL, `status` text NOT NULL, `pullRequestUrl` text, `fromFork` integer DEFAULT false NOT NULL, `createdAt` text NOT NULL, `archivedAt` text);",
				`INSERT INTO \`__new_workspace\` SELECT ${workspaceColumns} FROM \`workspace\`;`,
				"DROP TABLE `workspace`;",
				"ALTER TABLE `__new_workspace` RENAME TO `workspace`;",
				"PRAGMA foreign_keys=ON;",
			],
			bps: true,
			folderMillis: Number.MAX_SAFE_INTEGER,
			hash: "rebuild",
			name: "rebuild",
		};
		const counts = await run((dataDir) =>
			Effect.gen(function* () {
				const createdAt = "2026-01-01T00:00:00.000Z";
				yield* withDatabase(
					LocalDatabase.use((database) =>
						database.query((db) =>
							Effect.all([
								db.insert(project).values({ id: "p1", name: "repo", path: "/repo", defaultBranch: "main", createdAt }),
								db.insert(workspace).values({
									id: "w1",
									projectId: "p1",
									name: "repo",
									kind: "inPlace",
									path: "/repo",
									branch: "main",
									baseBranch: "main",
									status: "active",
									createdAt,
								}),
								db.insert(agentSession).values({
									id: "s1",
									workspaceId: "w1",
									agent: "codex",
									model: "gpt",
									authMode: "subscription",
									status: "idle",
									createdAt,
									updatedAt: createdAt,
								}),
								db.insert(sessionEvent).values({
									id: "e1",
									sessionId: "s1",
									sequence: 0,
									type: "user.message",
									payload: {},
									createdAt,
								}),
							]),
						),
					),
					dataDir,
				);
				yield* runMigrations([...embeddedMigrations(), rebuild]).pipe(
					Effect.provide(SqliteClient.layer({ filename: join(dataDir, DATABASE_FILE_NAME) })),
				);
				return yield* withDatabase(
					LocalDatabase.use((database) =>
						database.query((db) =>
							Effect.all([
								db.select({ rows: count() }).from(agentSession),
								db.select({ rows: count() }).from(sessionEvent),
							]),
						),
					),
					dataDir,
				);
			}),
		);
		expect(counts).toEqual([[{ rows: 1 }], [{ rows: 1 }]]);
	});

	test("fails startup when a migration leaves a row pointing at a missing parent", async () => {
		const orphaning: MigrationMeta = {
			sql: [
				"INSERT INTO `agentSession` (`id`, `workspaceId`, `agent`, `model`, `authMode`, `status`, `createdAt`, `updatedAt`) VALUES ('s1', 'missing', 'codex', 'gpt', 'subscription', 'idle', '', '');",
			],
			bps: true,
			folderMillis: Number.MAX_SAFE_INTEGER,
			hash: "orphaning",
			name: "orphaning",
		};
		const error = await run((dataDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				yield* fs.makeDirectory(dataDir, { recursive: true });
				return yield* runMigrations([...embeddedMigrations(), orphaning]).pipe(
					Effect.provide(SqliteClient.layer({ filename: join(dataDir, DATABASE_FILE_NAME) })),
					Effect.flip,
				);
			}),
		);
		expect(error._tag).toBe("DatabaseIntegrityError");
		expect(error.message).toContain("agentSession");
	});

	test("lists the images of messages sent before the attachment lookup existed", async () => {
		const migrations = embeddedMigrations();
		const before = migrations.slice(
			0,
			migrations.findIndex(({ name }) => name === "20261126183115_sessionAttachment"),
		);
		const rows = await run((dataDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				yield* fs.makeDirectory(dataDir, { recursive: true });
				yield* Effect.gen(function* () {
					yield* runMigrations(before);
					const client = yield* SqliteClient.SqliteClient;
					const message = JSON.stringify({
						type: "user.message",
						itemId: "u1",
						text: "look",
						attachments: [
							{ id: "a1", mediaType: "image/png" },
							{ id: "a2", mediaType: "image/jpeg" },
						],
					});
					yield* client`INSERT INTO project (id, name, path, defaultBranch, createdAt) VALUES ('p1', 'repo', '/repo', 'main', '')`;
					yield* client`INSERT INTO workspace (id, projectId, name, kind, path, branch, baseBranch, status, createdAt) VALUES ('w1', 'p1', 'repo', 'inPlace', '/repo', 'main', 'main', 'active', '')`;
					yield* client`INSERT INTO agentSession (id, workspaceId, agent, model, authMode, status, createdAt, updatedAt) VALUES ('s1', 'w1', 'codex', 'gpt', 'subscription', 'idle', '', '')`;
					yield* client`INSERT INTO sessionEvent (id, sessionId, sequence, type, payload, createdAt) VALUES ('e1', 's1', 0, 'user.message', ${message}, '')`;
				}).pipe(Effect.provide(SqliteClient.layer({ filename: join(dataDir, DATABASE_FILE_NAME) })));
				return yield* withDatabase(
					LocalDatabase.use((database) =>
						database.query((db) => db.select().from(sessionAttachment).orderBy(sessionAttachment.id)),
					),
					dataDir,
				);
			}),
		);
		expect(rows).toEqual([
			{ id: "a1", sessionId: "s1", mediaType: "image/png" },
			{ id: "a2", sessionId: "s1", mediaType: "image/jpeg" },
		]);
	});
});
