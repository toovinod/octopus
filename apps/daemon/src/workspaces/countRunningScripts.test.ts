import { project, scriptRun, workspace } from "../database/schema.ts";
import { testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { countRunningScripts } from "./countRunningScripts.ts";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import type { JobStatus } from "@repo/contracts/JobStatus";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, test } from "bun:test";

const at = "2026-01-01T00:00:00.000Z";

const runOf = (id: string, status: JobStatus) =>
	({ id, workspaceId: "w1", kind: "run", status, createdAt: at, updatedAt: at }) as const;

describe("countRunningScripts", () => {
	test("counts the scripts that are running or waiting to retry, in no matter which workspace", async () => {
		const running = await Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dataDir = yield* fs.makeTempDirectoryScoped();
			return yield* Effect.gen(function* () {
				const database = yield* LocalDatabase;
				yield* database.query((db) =>
					Effect.gen(function* () {
						yield* db
							.insert(project)
							.values({ id: "p1", name: "repo", path: "/repo", defaultBranch: "main", createdAt: at });
						yield* db.insert(workspace).values({
							id: "w1",
							projectId: "p1",
							name: "w1",
							kind: "inPlace",
							path: "/repo",
							branch: "main",
							baseBranch: "main",
							status: "active",
							createdAt: at,
						});
						yield* db
							.insert(scriptRun)
							.values([
								runOf("r1", "processing"),
								runOf("r2", "pending"),
								runOf("r3", "completed"),
								runOf("r4", "failed"),
								runOf("r5", "deadLetter"),
							]);
					}),
				);
				return yield* countRunningScripts();
			}).pipe(Effect.provide(LocalDatabase.layer.pipe(Layer.provide([testDaemonConfig(dataDir), BunServices.layer]))));
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
		expect(running).toBe(2);
	});
});
