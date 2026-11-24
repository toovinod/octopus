import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { runServiceTest } from "../testing/runServiceTest.ts";
import { WorkspaceService } from "./WorkspaceService.ts";
import { describe, expect, test } from "bun:test";
import { fakeGh } from "../testing/fakeGh.ts";
import { GhSettings } from "../git/runGh.ts";
import { Effect, FileSystem } from "effect";
import { runGit } from "../git/runGit.ts";
import { join } from "node:path";

const addProject = Effect.fn("addProject")(function* (tempDir: string) {
	const path = yield* makeTestRepository(join(tempDir, "repo"));
	return yield* Effect.flatMap(ProjectService, (projects) => projects.add(path));
});

const commitFile = Effect.fn("commitFile")(function* (cwd: string, file: string) {
	yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(join(cwd, file), `${file}\n`));
	yield* runGit(cwd, ["add", "."]);
	yield* runGit(cwd, ["commit", "-m", file]);
});

describe("WorkspaceService.create from a source", () => {
	test("branches a new worktree off the base branch the user picked", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				yield* runGit(project.path, ["checkout", "-q", "-b", "develop"]);
				yield* commitFile(project.path, "develop.txt");
				yield* runGit(project.path, ["checkout", "-q", "main"]);
				const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.create({ kind: "worktree", projectId: project.id, name: "feature", baseBranch: "develop" }),
				);
				const fs = yield* FileSystem.FileSystem;
				return { created, hasFile: yield* fs.exists(join(created.path, "develop.txt")) };
			}),
		);
		expect(result.created).toMatchObject({ branch: "feature", baseBranch: "develop" });
		expect(result.hasFile).toBe(true);
	});

	test("checks out an existing local branch in a folder named after it", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				yield* runGit(project.path, ["checkout", "-q", "-b", "feat/login"]);
				yield* commitFile(project.path, "login.txt");
				yield* runGit(project.path, ["checkout", "-q", "main"]);
				const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.create({ kind: "branch", projectId: project.id, branch: "feat/login" }),
				);
				return { created, checkedOut: yield* runGit(created.path, ["branch", "--show-current"]), project };
			}),
		);
		expect(result.created).toMatchObject({
			kind: "worktree",
			name: "feat/login",
			branch: "feat/login",
			baseBranch: "main",
		});
		expect(result.created.path.endsWith(join(result.project.id, "feat-login"))).toBe(true);
		expect(result.checkedOut).toBe("feat/login");
	});

	test("tracks a branch that only exists on origin", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const origin = join(tempDir, "origin.git");
				yield* runGit(tempDir, ["clone", "-q", "--bare", project.path, origin]);
				yield* runGit(project.path, ["remote", "add", "origin", origin]);
				const other = join(tempDir, "other");
				yield* runGit(tempDir, ["clone", "-q", origin, other]);
				yield* runGit(other, ["config", "user.email", "test@octopus.local"]);
				yield* runGit(other, ["config", "user.name", "Octopus Test"]);
				yield* runGit(other, ["checkout", "-q", "-b", "remote-only"]);
				yield* commitFile(other, "remote.txt");
				yield* runGit(other, ["push", "-q", "origin", "remote-only"]);
				yield* runGit(project.path, ["fetch", "-q", "origin"]);
				const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.create({ kind: "branch", projectId: project.id, branch: "remote-only" }),
				);
				return yield* runGit(created.path, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
			}),
		);
		expect(result).toBe("origin/remote-only");
	});

	test("refuses a branch that is missing or checked out in the project folder", async () => {
		const errors = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const workspaces = yield* WorkspaceService;
				return [
					yield* Effect.flip(workspaces.create({ kind: "branch", projectId: project.id, branch: "nope" })),
					yield* Effect.flip(workspaces.create({ kind: "branch", projectId: project.id, branch: "main" })),
				].map((error) => error._tag);
			}),
		);
		expect(errors).toEqual(["BranchNotFoundError", "BranchCheckedOutError"]);
	});

	test("checks out a pull request's head with gh, merging into its base", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const executable = yield* fakeGh(
					tempDir,
					`case "$1 $2" in
"pr view") echo '{"headRefName":"fix-bug","baseRefName":"main","isCrossRepository":false}' ;;
"pr checkout") git checkout -q -b "$5" ;;
esac`,
				);
				const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.create({ kind: "pullRequest", projectId: project.id, number: 7 }),
				).pipe(Effect.provideService(GhSettings, { executable }));
				const fs = yield* FileSystem.FileSystem;
				return {
					created,
					checkedOut: yield* runGit(created.path, ["branch", "--show-current"]),
					ghLog: yield* fs.readFileString(join(tempDir, "gh.log")),
				};
			}),
		);
		expect(result.created).toMatchObject({ branch: "fix-bug", baseBranch: "main", status: "active" });
		expect(result.checkedOut).toBe("fix-bug");
		expect(result.ghLog).toContain("pr checkout 7 --branch fix-bug");
	});

	test("names a fork's pull request branch after its number", async () => {
		const branch = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const executable = yield* fakeGh(
					tempDir,
					`case "$1 $2" in
"pr view") echo '{"headRefName":"main","baseRefName":"main","isCrossRepository":true}' ;;
"pr checkout") git checkout -q -b "$5" ;;
esac`,
				);
				const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.create({ kind: "pullRequest", projectId: project.id, number: 9 }),
				).pipe(Effect.provideService(GhSettings, { executable }));
				return created.branch;
			}),
		);
		expect(branch).toBe("pr-9-main");
	});

	test("removes the worktree when gh cannot check out the pull request", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const executable = yield* fakeGh(
					tempDir,
					`case "$1 $2" in
"pr view") echo '{"headRefName":"fix-bug","baseRefName":"main","isCrossRepository":false}' ;;
"pr checkout") exit 1 ;;
esac`,
				);
				const workspaces = yield* WorkspaceService;
				const error = yield* Effect.flip(
					workspaces.create({ kind: "pullRequest", projectId: project.id, number: 7 }),
				).pipe(Effect.provideService(GhSettings, { executable }));
				return {
					error,
					worktrees: yield* runGit(project.path, ["worktree", "list", "--porcelain"]),
					rows: yield* workspaces.list(project.id),
				};
			}),
		);
		expect(result.error._tag).toBe("PullRequestCheckoutError");
		expect(result.worktrees).not.toContain("fix-bug");
		expect(result.rows).toEqual([]);
	});

	test("lists local and origin branches once each", async () => {
		const branches = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const origin = join(tempDir, "origin.git");
				yield* runGit(project.path, ["branch", "topic"]);
				yield* runGit(tempDir, ["clone", "-q", "--bare", project.path, origin]);
				yield* runGit(project.path, ["remote", "add", "origin", origin]);
				yield* runGit(project.path, ["fetch", "-q", "origin"]);
				yield* runGit(project.path, ["remote", "set-head", "origin", "main"]);
				yield* runGit(project.path, ["branch", "local-only"]);
				return yield* Effect.flatMap(WorkspaceService, (workspaces) => workspaces.listProjectBranches(project.id));
			}),
		);
		expect(branches).toEqual(["local-only", "main", "topic"]);
	});

	test("lists open pull requests and issues through gh", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const executable = yield* fakeGh(
					tempDir,
					`case "$1 $2" in
"pr list") echo '[{"number":3,"title":"Fix","headRefName":"fix","author":{"login":"ada"}},{"number":4,"title":"Gone","headRefName":"x","author":null}]' ;;
"issue list") echo '[{"number":12,"title":"Crash on save","body":"Steps","url":"https://github.com/acme/repo/issues/12"}]' ;;
esac`,
				);
				const workspaces = yield* WorkspaceService;
				return yield* Effect.all({
					pullRequests: workspaces.listProjectPullRequests(project.id),
					issues: workspaces.listProjectIssues(project.id),
				}).pipe(Effect.provideService(GhSettings, { executable }));
			}),
		);
		expect(result.pullRequests.map((item) => [item.number, item.branch, item.author])).toEqual([
			[3, "fix", "ada"],
			[4, "x", "ghost"],
		]);
		expect(result.issues).toMatchObject([{ number: 12, title: "Crash on save", body: "Steps" }]);
	});

	test("reports a gh failure listing issues as a list error once gh is signed in", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const executable = yield* fakeGh(tempDir, `[ "$1" = "auth" ] && exit 0\nexit 1`);
				return yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					Effect.flip(workspaces.listProjectIssues(project.id)),
				).pipe(Effect.provideService(GhSettings, { executable }));
			}),
		);
		expect(error).toMatchObject({ _tag: "GitHubListError", subject: "issues" });
	});
});
