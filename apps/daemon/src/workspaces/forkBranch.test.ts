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

	// What `gh pr checkout` leaves when the user already has a remote for the fork, whatever its name.
	test("counts a branch that tracks a fork through a named remote as a fork's", async () => {
		const fork = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["remote", "add", "origin", "https://example.com/owner/app.git"]);
				yield* runGit(path, ["remote", "add", "contributor", "https://example.com/contributor/app.git"]);
				yield* runGit(path, ["checkout", "-b", "feature"]);
				yield* runGit(path, ["config", "branch.feature.remote", "contributor"]);
				yield* runGit(path, ["config", "branch.feature.merge", "refs/heads/feature"]);
				return yield* isForkCheckout(path);
			}),
		);
		expect(fork).toBe(true);
	});

	// The usual name for the repository a clone of a fork was forked from.
	test("does not count a branch that tracks upstream, even where gh never chose a base", async () => {
		const fork = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["remote", "add", "origin", "https://example.com/me/app.git"]);
				yield* runGit(path, ["remote", "add", "upstream", "https://example.com/owner/app.git"]);
				yield* runGit(path, ["checkout", "-b", "feature"]);
				yield* runGit(path, ["config", "branch.feature.remote", "upstream"]);
				yield* runGit(path, ["config", "branch.feature.merge", "refs/heads/main"]);
				return yield* isForkCheckout(path);
			}),
		);
		expect(fork).toBe(false);
	});

	test("does not count a branch that tracks the repository gh uses as the base", async () => {
		const fork = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["remote", "add", "origin", "https://example.com/me/app.git"]);
				yield* runGit(path, ["remote", "add", "upstream", "https://example.com/owner/app.git"]);
				yield* runGit(path, ["config", "remote.upstream.gh-resolved", "base"]);
				yield* runGit(path, ["checkout", "-b", "feature"]);
				yield* runGit(path, ["config", "branch.feature.remote", "upstream"]);
				yield* runGit(path, ["config", "branch.feature.merge", "refs/heads/main"]);
				return yield* isForkCheckout(path);
			}),
		);
		expect(fork).toBe(false);
	});
});

describe("isForkCheckout with branch names and marks git reads its own way", () => {
	// A repository on the given branch, with config entries set before the check.
	const checkout = (branch: string, entries: ReadonlyArray<readonly [string, string]>) =>
		runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["remote", "add", "origin", "https://example.com/owner/app.git"]);
				yield* runGit(path, ["checkout", "-b", branch]);
				for (const [key, value] of entries) yield* runGit(path, ["config", "--add", key, value]);
				return yield* isForkCheckout(path);
			}),
		);

	test("reads the mark of a branch whose name holds regex characters", async () => {
		expect(await checkout("feat/a.b+c", [["branch.feat/a.b+c.octopusFromFork", "true"]])).toBe(true);
	});

	test("ignores the mark of a branch whose name only matches as a regex", async () => {
		expect(await checkout("feat/a.b+c", [["branch.feat/aXb+c.octopusFromFork", "true"]])).toBe(false);
		expect(await checkout("feat/a.b+c", [["branch.feat/a.bbc.octopusFromFork", "true"]])).toBe(false);
	});

	test("keeps the case of the branch name in the mark's key", async () => {
		expect(await checkout("Feat/A", [["branch.feat/a.octopusFromFork", "true"]])).toBe(false);
		expect(await checkout("Feat/A", [["branch.Feat/A.octopusfromfork", "true"]])).toBe(true);
	});

	test("reads the mark the way git reads a boolean", async () => {
		for (const value of ["true", "TRUE", "yes", "On", "1", "2"]) {
			expect(await checkout("feature", [["branch.feature.octopusFromFork", value]])).toBe(true);
		}
		for (const value of ["false", "No", "OFF", "0", ""]) {
			expect(await checkout("feature", [["branch.feature.octopusFromFork", value]])).toBe(false);
		}
	});

	test("reads the last mark when the key is set more than once", async () => {
		const marks = (first: string, last: string) =>
			[
				["branch.feature.octopusFromFork", first],
				["branch.feature.octopusFromFork", last],
			] as const;
		expect(await checkout("feature", marks("true", "false"))).toBe(false);
		expect(await checkout("feature", marks("false", "yes"))).toBe(true);
	});

	test("counts a mark git cannot read as a boolean as a fork's", async () => {
		const fork = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				yield* runGit(path, ["checkout", "-b", "feature"]);
				yield* runGit(path, ["config", "branch.feature.octopusFromFork", "maybe"]);
				return yield* holdsForkCode({ fromFork: false, path });
			}),
		);
		expect(fork).toBe(true);
	});

	test("tells the base remote from a URL for a branch whose name holds regex characters", async () => {
		const tracking = (remote: string) => [
			["remote.up.stream.url", "https://example.com/upstream/app.git"] as const,
			["remote.up.stream.gh-resolved", "base"] as const,
			["branch.feat/a.b+c.remote", remote] as const,
			["branch.feat/a.b+c.merge", "refs/heads/feat/a.b+c"] as const,
		];
		expect(await checkout("feat/a.b+c", tracking("up.stream"))).toBe(false);
		expect(await checkout("feat/a.b+c", tracking("origin"))).toBe(false);
		expect(await checkout("feat/a.b+c", tracking("https://example.com/fork/app.git"))).toBe(true);
		expect(await checkout("feat/a.b+c", tracking("up"))).toBe(true);
	});
});

describe("holdsForkCode", () => {
	test("counts a folder git cannot read as a fork's", async () => {
		const fork = await runInTempDir((tempDir) => holdsForkCode({ fromFork: false, path: join(tempDir, "missing") }));
		expect(fork).toBe(true);
	});
});
