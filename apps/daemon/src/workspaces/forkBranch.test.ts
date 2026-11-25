import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { holdsForkCode, isForkCheckout } from "./forkBranch.ts";
import { runInTempDir } from "../testing/runServiceTest.ts";
import { describe, expect, test } from "bun:test";
import { runGit } from "../git/runGit.ts";
import { join } from "node:path";
import { Effect } from "effect";

describe("isForkCheckout", () => {
	// What `gh pr checkout` leaves for a fork's pull request that the fork's author keeps maintainers out of.
	test("counts a branch that pulls a pull request's head from origin as a fork's", async () => {
		const fork = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["remote", "add", "origin", "https://example.com/owner/app.git"]);
				yield* runGit(path, ["checkout", "-b", "pr-7-feature"]);
				yield* runGit(path, ["config", "branch.pr-7-feature.remote", "origin"]);
				yield* runGit(path, ["config", "branch.pr-7-feature.merge", "refs/pull/7/head"]);
				return yield* isForkCheckout(path);
			}),
		);
		expect(fork).toBe(true);
	});

	test("does not count a branch that tracks its own name on origin", async () => {
		const fork = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["remote", "add", "origin", "https://example.com/owner/app.git"]);
				yield* runGit(path, ["checkout", "-b", "feature"]);
				yield* runGit(path, ["config", "branch.feature.remote", "origin"]);
				yield* runGit(path, ["config", "branch.feature.merge", "refs/heads/feature"]);
				return yield* isForkCheckout(path);
			}),
		);
		expect(fork).toBe(false);
	});
});

describe("holdsForkCode", () => {
	test("counts a folder git cannot read as a fork's", async () => {
		const fork = await runInTempDir((tempDir) => holdsForkCode({ fromFork: false, path: join(tempDir, "missing") }));
		expect(fork).toBe(true);
	});
});
