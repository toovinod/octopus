import {
	CHECKPOINTS_PER_SESSION,
	changesSince,
	checkpointRef,
	deleteCheckpoints,
	findCheckpoint,
	restoreCheckpoint,
	saveCheckpoint,
} from "./workspaceCheckpoints.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { runServiceTest } from "../testing/runServiceTest.ts";
import { describe, expect, test } from "bun:test";
import { SecureRandom } from "effect/crypto";
import { Effect, FileSystem } from "effect";
import { runGit } from "../git/runGit.ts";
import { join } from "node:path";

describe("workspace checkpoints", () => {
	test("saves the files, lists what changed since, and puts them back without touching git's own state", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				const write = (path: string, text: string) => fs.writeFileString(join(repo, path), text);
				yield* write(".gitignore", "deps/\n");
				yield* fs.makeDirectory(join(repo, "deps"));
				yield* write("deps/lib.js", "installed\n");
				yield* write("README.md", "before the turn\n");
				yield* write("notes.txt", "untracked but kept\n");
				const ref = checkpointRef("workspace-1", "session-1", "message-1");
				yield* saveCheckpoint(repo, ref);

				// What an agent's turn might do.
				yield* write("README.md", "after the turn\n");
				yield* fs.remove(join(repo, "notes.txt"));
				yield* write("made-by-agent.ts", "new\n");
				yield* write("deps/lib.js", "reinstalled\n");

				const checkpoint = yield* findCheckpoint(repo, ref);
				if (checkpoint === null) return yield* Effect.die("no checkpoint");
				const { now, files } = yield* changesSince(repo, checkpoint);
				yield* restoreCheckpoint(repo, checkpoint, now);
				return {
					files,
					readme: yield* fs.readFileString(join(repo, "README.md")),
					notes: yield* fs.readFileString(join(repo, "notes.txt")),
					agentFileGone: !(yield* fs.exists(join(repo, "made-by-agent.ts"))),
					ignored: yield* fs.readFileString(join(repo, "deps/lib.js")),
					staged: yield* runGit(repo, ["diff", "--cached", "--name-only"]),
					head: yield* runGit(repo, ["log", "--format=%s"]),
					missing: yield* findCheckpoint(repo, checkpointRef("workspace-1", "session-1", "never-sent")),
				};
			}).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
		);
		expect(result.files).toEqual([
			{ path: "README.md", change: "modified" },
			{ path: "made-by-agent.ts", change: "added" },
			{ path: "notes.txt", change: "deleted" },
		]);
		expect(result.readme).toBe("before the turn\n");
		expect(result.notes).toBe("untracked but kept\n");
		expect(result.agentFileGone).toBe(true);
		expect(result.ignored).toBe("reinstalled\n");
		expect(result.staged).toBe("");
		expect(result.head).toBe("init");
		expect(result.missing).toBeNull();
	});

	test("keeps files ignored at the checkpoint, though the agent deleted the .gitignore", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				yield* fs.writeFileString(join(repo, ".gitignore"), ".env\n");
				yield* fs.writeFileString(join(repo, ".env"), "SECRET=1\n");
				const ref = checkpointRef("workspace-1", "session-1", "message-1");
				yield* saveCheckpoint(repo, ref);
				yield* fs.remove(join(repo, ".gitignore"));
				yield* fs.writeFileString(join(repo, "made-by-agent.ts"), "new\n");
				const checkpoint = yield* findCheckpoint(repo, ref);
				if (checkpoint === null) return yield* Effect.die("no checkpoint");
				const { now } = yield* changesSince(repo, checkpoint);
				yield* restoreCheckpoint(repo, checkpoint, now);
				return {
					env: yield* fs.exists(join(repo, ".env")),
					gitignore: yield* fs.exists(join(repo, ".gitignore")),
					agentFile: yield* fs.exists(join(repo, "made-by-agent.ts")),
				};
			}).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
		);
		expect(result).toEqual({ env: true, gitignore: true, agentFile: false });
	});

	test("puts the files back as they were when a revert fails partway", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				const ref = checkpointRef("workspace-1", "session-1", "message-1");
				yield* saveCheckpoint(repo, ref);
				yield* fs.writeFileString(join(repo, "README.md"), "after the turn\n");
				yield* fs.writeFileString(join(repo, "a-new.txt"), "made by the agent\n");
				// A folder whose file cannot be deleted makes the revert fail after it wrote README.md.
				yield* fs.makeDirectory(join(repo, "locked"));
				yield* fs.writeFileString(join(repo, "locked", "file.txt"), "x\n");
				yield* fs.chmod(join(repo, "locked"), 0o555);
				const checkpoint = yield* findCheckpoint(repo, ref);
				if (checkpoint === null) return yield* Effect.die("no checkpoint");
				const { now } = yield* changesSince(repo, checkpoint);
				const failed = yield* Effect.exit(restoreCheckpoint(repo, checkpoint, now));
				yield* fs.chmod(join(repo, "locked"), 0o755);
				return {
					failed: failed._tag,
					readme: yield* fs.readFileString(join(repo, "README.md")),
					newFile: yield* fs.exists(join(repo, "a-new.txt")),
				};
			}).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
		);
		expect(result).toEqual({ failed: "Failure", readme: "after the turn\n", newFile: true });
	});

	test("unstages changes staged after the checkpoint", async () => {
		const staged = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				const ref = checkpointRef("workspace-1", "session-1", "message-1");
				yield* saveCheckpoint(repo, ref);
				yield* fs.writeFileString(join(repo, "README.md"), "after the turn\n");
				yield* fs.writeFileString(join(repo, "added.txt"), "new\n");
				yield* runGit(repo, ["add", "README.md", "added.txt"]);
				const checkpoint = yield* findCheckpoint(repo, ref);
				if (checkpoint === null) return yield* Effect.die("no checkpoint");
				const { now } = yield* changesSince(repo, checkpoint);
				yield* restoreCheckpoint(repo, checkpoint, now);
				return yield* runGit(repo, ["status", "--porcelain"]);
			}).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
		);
		expect(staged).toBe("");
	});

	test("keeps only a session's latest checkpoints", async () => {
		const refs = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				const tree = yield* runGit(repo, ["write-tree"]);
				const id = (index: number) => String(index).padStart(4, "0");
				for (let index = 0; index < CHECKPOINTS_PER_SESSION; index++) {
					yield* runGit(repo, ["update-ref", checkpointRef("w", "s", id(index)), tree]);
				}
				yield* runGit(repo, ["update-ref", "refs/octopus/checkpoints/w/s/before-revert", tree]);
				yield* runGit(repo, ["update-ref", checkpointRef("w", "other", id(0)), tree]);
				yield* saveCheckpoint(repo, checkpointRef("w", "s", id(CHECKPOINTS_PER_SESSION)));
				return (yield* runGit(repo, ["for-each-ref", "--format=%(refname)", "refs/octopus/"])).split("\n");
			}).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
		);
		expect(refs).toHaveLength(CHECKPOINTS_PER_SESSION + 2);
		expect(refs).not.toContain("refs/octopus/checkpoints/w/s/0000");
		expect(refs).toContain("refs/octopus/checkpoints/w/s/0001");
		expect(refs).toContain("refs/octopus/checkpoints/w/s/before-revert");
		expect(refs).toContain("refs/octopus/checkpoints/w/other/0000");
	});

	test("deletes only the archived workspace's checkpoints", async () => {
		const refs = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const repo = yield* makeTestRepository(join(tempDir, "repo"));
				yield* saveCheckpoint(repo, checkpointRef("gone", "s", "1"));
				yield* saveCheckpoint(repo, checkpointRef("gone", "s", "2"));
				yield* saveCheckpoint(repo, checkpointRef("kept", "s", "1"));
				yield* deleteCheckpoints(repo, "gone");
				return yield* runGit(repo, ["for-each-ref", "--format=%(refname)", "refs/octopus/"]);
			}).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
		);
		expect(refs).toBe("refs/octopus/checkpoints/kept/s/1");
	});
});
