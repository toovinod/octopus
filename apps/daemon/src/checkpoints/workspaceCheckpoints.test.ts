import {
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
				const { files } = yield* changesSince(repo, checkpoint);
				yield* restoreCheckpoint(repo, checkpoint);
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
