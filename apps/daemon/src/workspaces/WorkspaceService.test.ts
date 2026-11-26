import { LIVE_LINES, MAX_FINISHED_OUTPUTS, SETUP_SCRIPTS_AT_ONCE, WorkspaceService } from "./WorkspaceService.ts";
import { runInTempDir, runServiceTest, waitForScriptRun, withServices } from "../testing/runServiceTest.ts";
import { checkpointRef, saveCheckpoint } from "../checkpoints/workspaceCheckpoints.ts";
import { Duration, Effect, Fiber, FileSystem, Layer, Schedule, Stream } from "effect";
import { SLOW_TO_STOP, waitForFile } from "../testing/processTesting.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { testAgentServices } from "../testing/testAgentServices.ts";
import { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import { TerminalService } from "../terminals/TerminalService.ts";
import { testDaemonConfig } from "../testing/testDaemonConfig.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { SessionService } from "../sessions/SessionService.ts";
import { SetupScriptSettings } from "./SetupScriptSettings.ts";
import { STOP_GRACE } from "../processes/stopProcessGroup.ts";
import { DaemonServices } from "../server/DaemonServices.ts";
import { LocalDatabase } from "../database/LocalDatabase.ts";
import { scriptRun, workspace } from "../database/schema.ts";
import { LINE_MAX_LENGTH } from "./capLineLength.ts";
import { describe, expect, test } from "bun:test";
import { SecureRandom } from "effect/crypto";
import { runGit } from "../git/runGit.ts";
import { eq, sql } from "drizzle-orm";
import { join } from "node:path";

const addProject = Effect.fn("addProject")(function* (tempDir: string, setupScript: string | null = null) {
	const projects = yield* ProjectService;
	const path = yield* makeTestRepository(join(tempDir, "repo"));
	const added = yield* projects.add(path);
	return yield* projects.updateScripts(added.id, {
		setupScript,
		runScript: null,
	});
});

const fastRetries = {
	timeout: Duration.millis(100),
	maxAttempts: 3,
	retryBaseDelay: Duration.millis(1),
};

const branchExists = (repositoryPath: string, branch: string) =>
	runGit(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).pipe(
		Effect.as(true),
		Effect.catchTag("GitCommandError", () => Effect.succeed(false)),
	);

describe("WorkspaceService", () => {
	test("creates a worktree on a new branch under the data dir", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* addProject(tempDir);
				const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.create({
						kind: "worktree",
						projectId: project.id,
						name: "feature",
					}),
				);
				return {
					created,
					folderExists: yield* fs.exists(join(created.path, "README.md")),
					branchExists: yield* branchExists(project.path, "feature"),
					expectedPath: join(tempDir, "data", "worktrees", project.id, "feature"),
				};
			}),
		);
		expect(result.created).toMatchObject({
			kind: "worktree",
			branch: "feature",
			baseBranch: "main",
			status: "active",
		});
		expect(result.created.path).toBe(result.expectedPath);
		expect(result.folderExists).toBe(true);
		expect(result.branchExists).toBe(true);
	});

	test("two projects whose folders share a name can each have a workspace with the same name", async () => {
		const paths = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const create = Effect.fn("create")(function* (parent: string) {
					const project = yield* projects.add(yield* makeTestRepository(join(tempDir, parent, "app")));
					return yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				});
				return [yield* create("a"), yield* create("b")].map((created) => created.path);
			}),
		);
		expect(new Set(paths).size).toBe(2);
	});

	test("branches whose names make the same folder name each get a folder of their own", async () => {
		const paths = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const long = "a".repeat(70);
				const branches = ["feat/x", `${long}-one`, `${long}-two`];
				for (const branch of branches) yield* runGit(project.path, ["branch", branch]);
				const named = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feat-x" });
				const fromBranches = yield* Effect.forEach(branches, (branch) =>
					workspaces.create({ kind: "branch", projectId: project.id, branch }),
				);
				return [named, ...fromBranches].map((created) => created.path);
			}),
		);
		expect(new Set(paths).size).toBe(4);
		expect(paths.every((path) => (path.split("/").at(-1)?.length ?? 0) <= 63)).toBe(true);
	});

	test("refuses a name whose branch already exists", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				yield* runGit(project.path, ["branch", "taken"]);
				return yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					Effect.flip(
						workspaces.create({
							kind: "worktree",
							projectId: project.id,
							name: "taken",
						}),
					),
				);
			}),
		);
		expect(error._tag).toBe("BranchAlreadyExistsError");
	});

	test("creates an in-place workspace on the project folder, once", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const first = yield* workspaces.create({
					kind: "inPlace",
					projectId: project.id,
				});
				const second = yield* Effect.flip(workspaces.create({ kind: "inPlace", projectId: project.id }));
				return { project, first, second };
			}),
		);
		expect(result.first).toMatchObject({
			kind: "inPlace",
			path: result.project.path,
			branch: "main",
		});
		expect(result.second._tag).toBe("WorkspacePathInUseError");
	});

	test("archives a clean worktree: removes the folder, keeps the branch", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				yield* saveCheckpoint(created.path, checkpointRef(created.id, "session", "message")).pipe(
					Effect.provide(SecureRandom.layerWebCrypto),
				);
				const archived = yield* workspaces.archive(created.id, {
					force: false,
				});
				return {
					archived,
					folderExists: yield* fs.exists(created.path),
					branchExists: yield* branchExists(project.path, "feature"),
					checkpoints: yield* runGit(project.path, ["for-each-ref", "refs/octopus/"]),
				};
			}),
		);
		expect(result.archived.status).toBe("archived");
		expect(result.archived.archivedAt).not.toBeNull();
		expect(result.folderExists).toBe(false);
		expect(result.branchExists).toBe(true);
		expect(result.checkpoints).toBe("");
	});

	test("refuses to archive unsaved work, then stashes it with force", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				yield* fs.writeFileString(join(created.path, "README.md"), "edited\n");
				yield* fs.writeFileString(join(created.path, "new.txt"), "new\n");
				const terminals = yield* TerminalService;
				yield* terminals.open(created.id, created.path, { cols: 80, rows: 24 });
				const refused = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				const stillThere = yield* fs.exists(created.path);
				// A refused archive changes nothing, so the workspace's terminals keep running.
				const terminalsAfterRefusal = terminals.list(created.id).length;
				const archived = yield* workspaces.archive(created.id, { force: true });
				return {
					created,
					refused,
					stillThere,
					terminalsAfterRefusal,
					terminalsAfterArchive: terminals.list(created.id).length,
					archived,
					folderExists: yield* fs.exists(created.path),
					stashes: yield* runGit(project.path, ["stash", "list"]),
					stashedFiles: yield* runGit(project.path, ["show", "--name-only", "--format=", "stash@{0}^3"]),
				};
			}),
		);
		expect(result.refused._tag).toBe("WorkspaceHasUnsavedWorkError");
		expect(result.refused).toMatchObject({
			changedFiles: ["README.md", "new.txt"],
			unpushedCommits: 0,
			ignoredFiles: [],
		});
		expect(result.stillThere).toBe(true);
		expect(result.terminalsAfterRefusal).toBe(1);
		expect(result.terminalsAfterArchive).toBe(0);
		expect(result.archived.status).toBe("archived");
		expect(result.folderExists).toBe(false);
		expect(result.stashes).toContain(`octopus-archive/${result.created.id}`);
		// The untracked file is in the stash's untracked-files commit.
		expect(result.stashedFiles).toBe("new.txt");
	});

	test("puts stashed changes back when the worktree cannot be removed", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* fs.writeFileString(join(created.path, "README.md"), "edited\n");
				yield* fs.writeFileString(join(created.path, "new.txt"), "new\n");
				// A locked worktree refuses `git worktree remove`.
				yield* runGit(project.path, ["worktree", "lock", created.path]);
				const failed = yield* Effect.flip(workspaces.archive(created.id, { force: true }));
				return {
					failed,
					readme: yield* fs.readFileString(join(created.path, "README.md")),
					untracked: yield* fs.exists(join(created.path, "new.txt")),
					stashes: yield* runGit(project.path, ["stash", "list"]),
					workspace: yield* workspaces.get(created.id),
				};
			}),
		);
		expect(result.failed._tag).toBe("WorktreeRemoveError");
		expect(result.readme).toBe("edited\n");
		expect(result.untracked).toBe(true);
		expect(result.stashes).toBe("");
		expect(result.workspace.status).toBe("active");
	});

	test("a forced archive interrupted after stashing still finishes, so the stash belongs to an archived workspace", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* fs.writeFileString(join(project.path, ".gitignore"), "node_modules/\n");
				yield* runGit(project.path, ["add", ".gitignore"]);
				yield* runGit(project.path, ["commit", "-m", "ignore"]);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				// Many ignored files are not stashed, so `git worktree remove` takes a while to delete them.
				const modules = join(created.path, "node_modules");
				yield* fs.makeDirectory(modules);
				yield* Effect.forEach(
					Array.from({ length: 4000 }, (_, index) => index),
					(index) => fs.writeFileString(join(modules, `${index}.js`), "installed\n"),
					{ concurrency: 64, discard: true },
				);
				yield* fs.writeFileString(join(created.path, "README.md"), "edited\n");
				const archiving = yield* Effect.forkChild(workspaces.archive(created.id, { force: true }));
				// Interrupted, as a quit or a dropped connection would, as soon as the changes are stashed.
				yield* runGit(project.path, ["stash", "list"]).pipe(
					Effect.repeat({ schedule: Schedule.spaced("2 millis"), until: (list) => list !== "" }),
					Effect.timeout("10 seconds"),
				);
				yield* Fiber.interrupt(archiving);
				return {
					workspace: yield* workspaces.get(created.id),
					folderExists: yield* fs.exists(created.path),
					stashes: yield* runGit(project.path, ["stash", "list"]),
				};
			}),
		);
		expect(result.workspace.status).toBe("archived");
		expect(result.folderExists).toBe(false);
		expect(result.stashes).toContain(`octopus-archive/${result.workspace.id}`);
	});

	test("a forced archive on a detached HEAD keeps the commits made there on a branch", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* runGit(created.path, ["checkout", "--detach"]);
				yield* runGit(created.path, ["commit", "--allow-empty", "-m", "detached work"]);
				const commit = yield* runGit(created.path, ["rev-parse", "HEAD"]);
				const refused = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				yield* workspaces.archive(created.id, { force: true });
				return {
					refused,
					commit,
					kept: yield* runGit(project.path, ["rev-parse", `refs/heads/octopus-archive/${created.id}-head`]),
				};
			}),
		);
		expect(result.refused).toMatchObject({ _tag: "WorkspaceHasUnsavedWorkError", unpushedCommits: 1 });
		expect(result.kept).toBe(result.commit);
	});

	test("counts commits no remote has as unsaved work", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				yield* runGit(created.path, ["commit", "--allow-empty", "-m", "work"]);
				const refused = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				const archived = yield* workspaces.archive(created.id, { force: true });
				return {
					refused,
					archived,
					branchHead: yield* runGit(project.path, ["log", "-1", "--format=%s", "feature"]),
				};
			}),
		);
		expect(result.refused).toMatchObject({
			_tag: "WorkspaceHasUnsavedWorkError",
			changedFiles: [],
			unpushedCommits: 1,
		});
		expect(result.archived.status).toBe("archived");
		expect(result.branchHead).toBe("work");
	});

	test("archives a workspace whose base branch was deleted, refusing unpushed commits without force", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* runGit(project.path, ["branch", "develop"]);
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
					baseBranch: "develop",
				});
				yield* runGit(project.path, ["branch", "-D", "develop"]);
				const refused = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				const archived = yield* workspaces.archive(created.id, { force: true });
				return { refused, archived };
			}),
		);
		expect(result.refused._tag).toBe("WorkspaceHasUnsavedWorkError");
		expect(result.archived.status).toBe("archived");
	});

	test("refuses to archive ignored files such as .env, but not installed dependencies, unless forced", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* fs.writeFileString(join(project.path, ".gitignore"), ".env\nnode_modules/\n");
				yield* runGit(project.path, ["add", ".gitignore"]);
				yield* runGit(project.path, ["commit", "-m", "ignore"]);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* fs.writeFileString(join(created.path, ".env"), "SECRET=1\n");
				yield* fs.makeDirectory(join(created.path, "node_modules"));
				yield* fs.writeFileString(join(created.path, "node_modules", "lib.js"), "installed\n");
				const refused = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				const archived = yield* workspaces.archive(created.id, { force: true });
				return { refused, archived, folderExists: yield* fs.exists(created.path) };
			}),
		);
		expect(result.refused).toMatchObject({
			_tag: "WorkspaceHasUnsavedWorkError",
			changedFiles: [],
			unpushedCommits: 0,
			ignoredFiles: [".env"],
		});
		expect(result.archived.status).toBe("archived");
		expect(result.folderExists).toBe(false);
	});

	test("archives a worktree whose only ignored files are build output that a build makes again", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* fs.writeFileString(join(project.path, ".gitignore"), "dist/\n.next/\n__pycache__/\n");
				yield* fs.makeDirectory(join(project.path, "packages", "app"), { recursive: true });
				yield* fs.writeFileString(join(project.path, "packages", "app", "index.js"), "app\n");
				yield* runGit(project.path, ["add", "."]);
				yield* runGit(project.path, ["commit", "-m", "ignore"]);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				for (const folder of ["dist", ".next", join("packages", "app", "dist"), join("packages", "__pycache__")]) {
					yield* fs.makeDirectory(join(created.path, folder), { recursive: true });
					yield* fs.writeFileString(join(created.path, folder, "out.js"), "built\n");
				}
				return yield* workspaces.archive(created.id, { force: false });
			}),
		);
		expect(result.status).toBe("archived");
	});

	test("archives a worktree with an initialized submodule", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const library = yield* makeTestRepository(join(tempDir, "library"));
				const allowFile = ["-c", "protocol.file.allow=always"];
				yield* runGit(project.path, [...allowFile, "submodule", "add", "-q", library, "library"]);
				yield* runGit(project.path, ["commit", "-m", "add library"]);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* runGit(created.path, [...allowFile, "submodule", "update", "-q", "--init"]);
				const archived = yield* workspaces.archive(created.id, { force: false });
				return { archived, folderExists: yield* fs.exists(created.path) };
			}),
		);
		expect(result.archived.status).toBe("archived");
		expect(result.folderExists).toBe(false);
	});

	test("archives a worktree whose folder is no longer a worktree, and leaves the folder", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				// The `.git` file links the folder to the repository. Without it git cannot work in the folder.
				yield* fs.remove(join(created.path, ".git"));
				const archived = yield* workspaces.archive(created.id, { force: false });
				return {
					archived,
					readme: yield* fs.exists(join(created.path, "README.md")),
					worktrees: yield* runGit(project.path, ["worktree", "list", "--porcelain"]),
				};
			}),
		);
		expect(result.archived.status).toBe("archived");
		expect(result.readme).toBe(true);
		expect(result.worktrees).not.toContain("feature");
	});

	test("archiving an in-place workspace removes nothing", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* fs.writeFileString(join(project.path, "dirty.txt"), "x\n");
				const created = yield* workspaces.create({
					kind: "inPlace",
					projectId: project.id,
				});
				const archived = yield* workspaces.archive(created.id, {
					force: false,
				});
				return {
					archived,
					dirtyFileKept: yield* fs.exists(join(project.path, "dirty.txt")),
				};
			}),
		);
		expect(result.archived.status).toBe("archived");
		expect(result.dirtyFileKept).toBe(true);
	});

	test("removing a project is refused while it has active workspaces", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const database = yield* LocalDatabase;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({
					kind: "inPlace",
					projectId: project.id,
				});
				const refused = yield* Effect.flip(projects.remove(project.id));
				yield* workspaces.archive(created.id, { force: false });
				yield* projects.remove(project.id);
				const leftover = yield* database.query((db) => db.select().from(workspace).where(eq(workspace.id, created.id)));
				return { refused, leftover, listed: yield* projects.list };
			}),
		);
		expect(result.refused).toMatchObject({
			_tag: "ProjectHasActiveWorkspacesError",
			activeWorkspaces: 1,
		});
		expect(result.leftover).toEqual([]);
		expect(result.listed).toEqual([]);
	});

	test("runs the setup script in the background and keeps its output", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "sleep 0.2; echo hello; echo oops >&2; pwd");
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				const [rightAfterCreate] = yield* workspaces.listScriptRuns(created.id);
				const finished = yield* waitForScriptRun(created.id);
				const output = workspaces.getScriptRunOutput(finished?.id ?? "");
				return { created, rightAfterCreate, finished, output };
			}),
		);
		expect(result.rightAfterCreate?.status).toMatch(/pending|processing/);
		expect(result.finished).toMatchObject({
			kind: "setup",
			status: "completed",
			exitCode: 0,
			attempts: 0,
		});
		expect(result.output.output).toContain("hello");
		expect(result.output.output).toContain("oops");
		expect(result.output.output).toContain(result.created.path);
	});

	test("a setup script that leaves a child running in the background finishes when the script exits", async () => {
		const run = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "sleep 30 & echo started");
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				const finished = yield* waitForScriptRun(created.id);
				return { finished, output: workspaces.getScriptRunOutput(finished?.id ?? "").output };
			}),
		);
		expect(run.finished).toMatchObject({ status: "completed", exitCode: 0 });
		expect(run.output).toContain("started");
	});

	test("a failing setup script fails at once, without retries", async () => {
		const run = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "exit 3");
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				return yield* waitForScriptRun(created.id);
			}),
		);
		expect(run).toMatchObject({
			status: "failed",
			exitCode: 3,
			attempts: 0,
			lastError: "The setup script exited with code 3.",
		});
	});

	test("starts a failed setup script over when the user runs it again, and refuses once archived", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "exit 3");
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				const failed = yield* waitForScriptRun(created.id);
				yield* Effect.flatMap(ProjectService, (projects) =>
					projects.updateScripts(project.id, { setupScript: "true", runScript: null }),
				);
				const started = yield* workspaces.startSetupScriptRun(created.id);
				const retried = yield* waitForScriptRun(created.id);
				yield* workspaces.archive(created.id, { force: true });
				const refused = yield* Effect.flip(workspaces.startSetupScriptRun(created.id));
				return { failed, started, retried, runs: yield* workspaces.listScriptRuns(created.id), refused };
			}),
		);
		expect(result.failed?.status).toBe("failed");
		expect(result.started).toMatchObject({ id: result.failed?.id, status: "pending", attempts: 0, lastError: null });
		expect(result.retried).toMatchObject({ id: result.failed?.id, status: "completed", attempts: 0, lastError: null });
		expect(result.runs).toHaveLength(1);
		expect(result.refused._tag).toBe("WorkspaceArchivedError");
	});

	test("runs only a few setup scripts at once", async () => {
		const log = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const logPath = join(tempDir, "setup.log");
				const project = yield* addProject(tempDir, `echo start >> ${logPath}; sleep 0.3; echo end >> ${logPath}`);
				const names = Array.from({ length: SETUP_SCRIPTS_AT_ONCE + 1 }, (_, index) => `feature-${index}`);
				const created = yield* Effect.forEach(names, (name) =>
					workspaces.create({ kind: "worktree", projectId: project.id, name }),
				);
				yield* Effect.forEach(created, (each) => waitForScriptRun(each.id));
				return yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(logPath));
			}),
		);
		const lines = log.trim().split("\n");
		expect(lines.slice(0, SETUP_SCRIPTS_AT_ONCE + 1)).toEqual([
			...Array.from({ length: SETUP_SCRIPTS_AT_ONCE }, () => "start"),
			"end",
		]);
	});

	test("a setup script waiting out its retry delay lets the next one run", async () => {
		const run = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				// Only the `fast` workspace's script finishes; the others time out and wait to retry.
				const project = yield* addProject(
					tempDir,
					'if [ "$(git branch --show-current)" = fast ]; then echo ok; else sleep 5; fi',
				);
				const names = [...Array.from({ length: SETUP_SCRIPTS_AT_ONCE }, (_, index) => `slow-${index}`), "fast"];
				const created = yield* Effect.forEach(names, (name) =>
					workspaces.create({ kind: "worktree", projectId: project.id, name }),
				);
				return yield* waitForScriptRun(created.at(-1)?.id ?? "");
			}).pipe(
				Effect.provideService(SetupScriptSettings, {
					timeout: Duration.millis(100),
					maxAttempts: 3,
					retryBaseDelay: Duration.minutes(1),
				}),
			),
		);
		expect(run?.status).toBe("completed");
	});

	test("a timed-out setup script is retried, then dead-lettered", async () => {
		const run = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "sleep 5");
				const created = yield* workspaces.create({
					kind: "worktree",
					projectId: project.id,
					name: "feature",
				});
				return yield* waitForScriptRun(created.id);
			}).pipe(Effect.provideService(SetupScriptSettings, fastRetries)),
		);
		expect(run).toMatchObject({
			status: "deadLetter",
			attempts: 3,
			lastError: "The setup script did not finish within 100ms.",
		});
		expect(run?.finishedAt).not.toBeNull();
	});

	test("on startup, a run cut off in processing is retried", async () => {
		const run = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const dataDir = join(tempDir, "data");
				// First lifetime: a worktree whose setup run was mid-flight when the daemon died.
				const workspaceId = yield* withServices(dataDir)(
					Effect.gen(function* () {
						const project = yield* addProject(tempDir);
						const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
							workspaces.create({
								kind: "worktree",
								projectId: project.id,
								name: "feature",
							}),
						);
						yield* Effect.flatMap(ProjectService, (projects) =>
							projects.updateScripts(project.id, {
								setupScript: "echo recovered",
								runScript: null,
							}),
						);
						yield* Effect.flatMap(LocalDatabase, (database) =>
							database.query((db) =>
								db.insert(scriptRun).values({
									id: "cut-off-run",
									workspaceId: created.id,
									kind: "setup",
									status: "processing",
									attempts: 0,
									createdAt: "2026-11-07T00:00:00.000Z",
									updatedAt: "2026-11-07T00:00:00.000Z",
									startedAt: "2026-11-07T00:00:00.000Z",
								}),
							),
						);
						return created.id;
					}),
				);
				// Second lifetime: startup recovery picks the run up again.
				return yield* withServices(dataDir)(waitForScriptRun(workspaceId));
			}),
		);
		expect(run).toMatchObject({
			id: "cut-off-run",
			status: "completed",
			attempts: 1,
			exitCode: 0,
		});
	});

	test("on startup, removes a worktree folder that no workspace owns and keeps its branch", async () => {
		const result = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dataDir = join(tempDir, "data");
				// First lifetime: one workspace, and a folder a crash left before its workspace was saved.
				const { project, created, orphan } = yield* withServices(dataDir)(
					Effect.gen(function* () {
						const project = yield* addProject(tempDir);
						const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
							workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" }),
						);
						const orphan = join(dataDir, "worktrees", project.id, "orphan");
						yield* runGit(project.path, ["worktree", "add", "-q", "-b", "orphan", orphan]);
						return { project, created, orphan };
					}),
				);
				// Second lifetime: startup finds the orphan.
				yield* withServices(dataDir)(Effect.void);
				return {
					orphanExists: yield* fs.exists(orphan),
					ownedExists: yield* fs.exists(created.path),
					orphanBranch: yield* branchExists(project.path, "orphan"),
				};
			}),
		);
		expect(result).toEqual({ orphanExists: false, ownedExists: true, orphanBranch: true });
	});

	test("on startup, a project that cannot be checked does not keep the others' orphans", async () => {
		const result = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const dataDir = join(tempDir, "data");
				// First lifetime: a project whose folder goes away later, then one with an orphan.
				const { broken, orphan } = yield* withServices(dataDir)(
					Effect.gen(function* () {
						const projects = yield* ProjectService;
						const broken = yield* projects.add(yield* makeTestRepository(join(tempDir, "gone", "repo")));
						yield* fs.makeDirectory(join(dataDir, "worktrees", broken.id), { recursive: true });
						// Added later, so startup checks it after the broken one.
						yield* Effect.sleep("10 millis");
						const project = yield* projects.add(yield* makeTestRepository(join(tempDir, "kept", "repo")));
						const orphan = join(dataDir, "worktrees", project.id, "orphan");
						yield* runGit(project.path, ["worktree", "add", "-q", "-b", "orphan", orphan]);
						return { broken, orphan };
					}),
				);
				yield* fs.remove(broken.path, { recursive: true });
				// Second lifetime: startup still finds the orphan.
				yield* withServices(dataDir)(Effect.void);
				return yield* fs.exists(orphan);
			}),
		);
		expect(result).toBe(false);
	});

	test("removes the new worktree and branch when the workspace cannot be saved", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* addProject(tempDir);
				const database = yield* LocalDatabase;
				yield* database.query((db) =>
					db.run(sql`CREATE TRIGGER failInsert BEFORE INSERT ON workspace BEGIN SELECT RAISE(ABORT, 'disk full'); END`),
				);
				const error = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					Effect.flip(workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" })),
				);
				return {
					error,
					folderExists: yield* fs.exists(join(tempDir, "data", "worktrees", "repo", "feature")),
					branchExists: yield* branchExists(project.path, "feature"),
				};
			}),
		);
		expect(result.error._tag).toBe("LocalDatabaseError");
		expect(result.folderExists).toBe(false);
		expect(result.branchExists).toBe(false);
	});

	test("archiving the same workspace from several calls at once archives it once", async () => {
		const results = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const project = yield* addProject(tempDir);
				const workspaces = yield* WorkspaceService;
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				const archive = workspaces.archive(created.id, { force: false });
				return yield* Effect.all([archive, archive, archive, archive], { concurrency: "unbounded" });
			}),
		);
		expect(results.map((archived) => archived.status)).toEqual(["archived", "archived", "archived", "archived"]);
	});

	test("archiving stops the workspace's scripts at once, not one after another", async () => {
		const took = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				// Scripts that ignore SIGTERM, so each needs the whole stop grace and then SIGKILL.
				const stubborn = "trap '' TERM; echo ready; while true; do sleep 0.1; done";
				yield* projects.updateScripts(project.id, { setupScript: stubborn, runScript: stubborn });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const runs = [yield* workspaces.startSetupScriptRun(created.id), yield* workspaces.startRunScript(created.id)];
				for (const run of runs) {
					yield* workspaces.followScriptRunOutput(run.id).pipe(Stream.take(1), Stream.runDrain);
				}
				const [elapsed] = yield* Effect.timed(workspaces.archive(created.id, { force: false }));
				return Duration.toMillis(elapsed);
			}),
		);
		expect(took).toBeLessThan(Duration.toMillis(STOP_GRACE) * 1.5);
	}, 20_000);

	test("runs the run script, streams its output, and stops it", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				// exec keeps the shell from forking after the line is printed: a stop that lands while it forks would
				// miss the new child, which then outlives SIGTERM until the stop grace runs out and SIGKILL reaches it.
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: "echo serving; exec sleep 30" });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const started = yield* workspaces.startRunScript(created.id);
				const again = yield* workspaces.startRunScript(created.id);
				const firstLine = yield* workspaces.followScriptRunOutput(started.id).pipe(Stream.take(1), Stream.runCollect);
				// A follower that stays attached sees the stream end when the script stops.
				const follower = yield* Effect.forkChild(Stream.runCollect(workspaces.followScriptRunOutput(started.id)));
				yield* workspaces.stopRunScript(created.id);
				return {
					started,
					again,
					firstLine,
					followed: yield* Fiber.join(follower),
					runs: yield* workspaces.listScriptRuns(created.id),
				};
			}),
		);
		expect(result.again.id).toBe(result.started.id);
		expect(result.firstLine).toEqual(["serving"]);
		expect(result.followed).toEqual(["serving"]);
		expect(result.runs).toMatchObject([{ kind: "run", status: "failed", lastError: "Stopped." }]);
	});

	test("finds the port a run script's child process listens on", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				// The server is a child of the script's shell, as a dev server started by a package script is.
				const serve = `"${process.execPath}" -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port)'`;
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: `${serve}; echo stopped` });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const started = yield* workspaces.startRunScript(created.id);
				const [printed] = yield* workspaces.followScriptRunOutput(started.id).pipe(Stream.take(1), Stream.runCollect);
				const ports = yield* workspaces.watchRunScriptPorts(created.id).pipe(
					Stream.filter((found) => found.length > 0),
					Stream.take(1),
					Stream.runCollect,
					Effect.timeout("10 seconds"),
				);
				yield* workspaces.stopRunScript(created.id);
				const afterStop = yield* workspaces.watchRunScriptPorts(created.id).pipe(Stream.take(1), Stream.runCollect);
				return { printed: Number(printed), ports: ports[0], afterStop: afterStop[0] };
			}),
		);
		expect(result.ports).toEqual([result.printed]);
		expect(result.afterStop).toEqual([]);
	});

	test("watchers of one run script share each look for its ports", async () => {
		const spawned: Array<number> = [];
		const recordingRegistry = Layer.succeed(
			ProcessRegistry,
			ProcessRegistry.of({
				add: (pgid) => Effect.sync(() => spawned.push(pgid)),
				remove: () => Effect.void,
				stopAll: Effect.void,
			}),
		);
		const counts = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: "echo serving; sleep 30" });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const started = yield* workspaces.startRunScript(created.id);
				yield* workspaces.followScriptRunOutput(started.id).pipe(Stream.take(1), Stream.runDrain);
				// Each look spawns the same commands, so the spawns count the looks.
				const spawnsFor = Effect.fn("spawnsFor")(function* (watchers: number) {
					const before = spawned.length;
					yield* Effect.all(
						Array.from({ length: watchers }, () =>
							workspaces.watchRunScriptPorts(created.id).pipe(Stream.take(1), Stream.runDrain),
						),
						{ concurrency: "unbounded" },
					);
					return spawned.length - before;
				});
				const one = yield* spawnsFor(1);
				// Past the poll interval, so the next look is a fresh one.
				yield* Effect.sleep("2100 millis");
				const three = yield* spawnsFor(3);
				yield* workspaces.stopRunScript(created.id);
				return { one, three };
			}).pipe(
				Effect.provide(
					DaemonServices.pipe(
						Layer.provideMerge(testAgentServices()),
						Layer.provide([testDaemonConfig(join(tempDir, "data")), recordingRegistry]),
					),
				),
			),
		);
		expect(counts.one).toBeGreaterThan(0);
		expect(counts.three).toBe(counts.one);
	});

	test("a run script that exits records its exit code", async () => {
		const run = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: "exit 4" });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const started = yield* workspaces.startRunScript(created.id);
				yield* Stream.runDrain(workspaces.followScriptRunOutput(started.id));
				return yield* waitForScriptRun(created.id);
			}),
		);
		expect(run).toMatchObject({
			kind: "run",
			status: "failed",
			exitCode: 4,
			lastError: "The run script exited with code 4.",
		});
	});

	test("refuses to start a run script the project does not have", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				return yield* Effect.flip(workspaces.startRunScript(created.id));
			}),
		);
		expect(error._tag).toBe("RunScriptMissingError");
	});

	test("on startup, a run script cut off by a restart is stopped, not started again", async () => {
		const runs = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const dataDir = join(tempDir, "data");
				const workspaceId = yield* withServices(dataDir)(
					Effect.gen(function* () {
						const projects = yield* ProjectService;
						const project = yield* addProject(tempDir);
						yield* projects.updateScripts(project.id, { setupScript: null, runScript: "sleep 30" });
						const created = yield* Effect.flatMap(WorkspaceService, (workspaces) =>
							workspaces.create({ kind: "inPlace", projectId: project.id }),
						);
						yield* Effect.flatMap(WorkspaceService, (workspaces) => workspaces.startRunScript(created.id));
						return created.id;
					}),
				);
				return yield* withServices(dataDir)(
					Effect.flatMap(WorkspaceService, (workspaces) => workspaces.listScriptRuns(workspaceId)),
				);
			}),
		);
		expect(runs).toMatchObject([
			{ kind: "run", status: "failed", lastError: "The daemon restarted, so the run script stopped." },
		]);
	});

	test("archiving a workspace closes its terminals", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* terminals.open(created.id, created.path, { cols: 80, rows: 24 });
				const before = terminals.list(created.id).length;
				yield* workspaces.archive(created.id, { force: false });
				return { before, after: terminals.list(created.id).length };
			}),
		);
		expect(result).toEqual({ before: 1, after: 0 });
	});
	test("work started while the workspace is being archived is refused", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const projects = yield* ProjectService;
				const sessions = yield* SessionService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: SLOW_TO_STOP });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const session = yield* sessions.create({
					workspaceId: created.id,
					agent: "codex",
					model: "replay",
					effort: null,
				});
				const run = yield* workspaces.startRunScript(created.id);
				yield* workspaces.followScriptRunOutput(run.id).pipe(Stream.take(1), Stream.runDrain);
				const archiving = yield* Effect.forkChild(workspaces.archive(created.id, { force: false }));
				yield* waitForFile(join(project.path, "stopping"));
				const attempts = yield* Effect.forkChild(
					Effect.all(
						[
							Effect.flip(sessions.create({ workspaceId: created.id, agent: "codex", model: "replay", effort: null })),
							Effect.flip(sessions.sendMessage(session.id, "hello", [], false)),
							Effect.flip(workspaces.startRunScript(created.id)),
						],
						{ concurrency: "unbounded" },
					),
				);
				yield* fs.writeFileString(join(project.path, "release"), "");
				const archived = yield* Fiber.join(archiving);
				return { archived: archived.status, refused: (yield* Fiber.join(attempts)).map((error) => error._tag) };
			}),
		);
		expect(result).toEqual({
			archived: "archived",
			refused: ["WorkspaceNotFoundError", "WorkspaceArchivedError", "WorkspaceArchivedError"],
		});
	}, 15_000);

	test("a workspace whose archive failed takes new work again", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const sessions = yield* SessionService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: "echo serving" });
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				// A locked worktree refuses `git worktree remove`.
				yield* runGit(project.path, ["worktree", "lock", created.path]);
				const failed = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				const session = yield* sessions.create({
					workspaceId: created.id,
					agent: "codex",
					model: "replay",
					effort: null,
				});
				yield* sessions.sendMessage(session.id, "hello", [], false);
				const run = yield* workspaces.startRunScript(created.id);
				return { failed: failed._tag, run: run.kind };
			}),
		);
		expect(result).toEqual({ failed: "WorktreeRemoveError", run: "run" });
	});

	// Architecture section 14 caps each subscriber's buffer at 1,000 events or 1 MB.
	test("a slow follower's live buffer holds at most about a megabyte", () => {
		expect(LIVE_LINES * LINE_MAX_LENGTH).toBeLessThanOrEqual(1024 * 1024);
	});

	test("a long line is cut to the line cap before it is kept or streamed", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				// The pause lets the follower attach first, so the long line reaches it live.
				const script = "echo ready; sleep 0.3; head -c 300000 /dev/zero | tr '\\0' x; echo; echo after";
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: script });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const run = yield* workspaces.startRunScript(created.id);
				const streamed = yield* Stream.runCollect(workspaces.followScriptRunOutput(run.id));
				return { streamed, kept: workspaces.getScriptRunOutput(run.id).output.split("\n") };
			}),
		);
		const cut = "x".repeat(LINE_MAX_LENGTH);
		expect(result.streamed).toEqual(["ready", cut, "after"]);
		expect(result.kept).toEqual(["ready", cut, "after"]);
	});

	test("keeps the output of the latest finished runs only", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: "echo done" });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const runs = [];
				for (let i = 0; i <= MAX_FINISHED_OUTPUTS; i++) {
					const run = yield* workspaces.startRunScript(created.id);
					yield* Stream.runDrain(workspaces.followScriptRunOutput(run.id));
					yield* waitForScriptRun(created.id);
					runs.push(run.id);
				}
				return runs.map((id) => workspaces.getScriptRunOutput(id).output);
			}),
		);
		expect(result).toEqual(["", ...Array(MAX_FINISHED_OUTPUTS).fill("done")]);
	});

	test("streams each status change of the workspace's script runs", async () => {
		const statuses = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				yield* projects.updateScripts(project.id, { setupScript: null, runScript: "echo done" });
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const other = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "other" });
				const watching = yield* Effect.forkChild(
					workspaces.watchScriptRuns(created.id).pipe(
						Stream.takeUntil((run) => run.status === "completed"),
						Stream.runCollect,
						Effect.timeout("5 seconds"),
					),
				);
				// Let the subscription register before the runs start.
				yield* Effect.sleep("100 millis");
				yield* workspaces.startRunScript(other.id);
				yield* workspaces.startRunScript(created.id);
				return (yield* Fiber.join(watching)).map((run) => [run.workspaceId === created.id, run.status]);
			}),
		);
		expect(statuses).toEqual([
			[true, "processing"],
			[true, "completed"],
		]);
	});
});

describe("WorkspaceService.unarchive", () => {
	test("returns an active workspace as it is now, as on a fork's branch checked out since", async () => {
		const restored = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				// What `gh pr checkout` leaves for a fork's pull request that keeps maintainers out.
				yield* runGit(project.path, ["remote", "add", "origin", "https://example.com/owner/app.git"]);
				yield* runGit(project.path, ["checkout", "-b", "pr-7-feature"]);
				yield* runGit(project.path, ["config", "branch.pr-7-feature.remote", "origin"]);
				yield* runGit(project.path, ["config", "branch.pr-7-feature.merge", "refs/pull/7/head"]);
				return yield* workspaces.unarchive(created.id);
			}),
		);
		expect(restored).toMatchObject({ status: "active", fromFork: true });
	});

	test("a project removed while a workspace is being restored leaves no folder behind", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const projects = yield* ProjectService;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* workspaces.archive(created.id, { force: false });
				const restoring = yield* Effect.forkChild(Effect.exit(workspaces.unarchive(created.id)));
				// While git adds the worktree again, the project, with only archived workspaces, can still go.
				yield* fs
					.exists(created.path)
					.pipe(
						Effect.repeat({ schedule: Schedule.spaced("1 millis"), until: (exists) => exists }),
						Effect.timeout("10 seconds"),
					);
				yield* projects.remove(project.id);
				const restored = yield* Fiber.join(restoring);
				return {
					failure: restored._tag === "Failure" ? String(restored.cause) : null,
					folderExists: yield* fs.exists(created.path),
					worktrees: yield* runGit(project.path, ["worktree", "list", "--porcelain"]),
				};
			}),
		);
		expect(result.failure).toContain("WorkspaceNotFoundError");
		expect(result.folderExists).toBe(false);
		expect(result.worktrees).not.toContain("feature");
	});

	test("brings back a force-archived worktree with its stashed changes", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* fs.writeFileString(join(created.path, "README.md"), "edited\n");
				yield* fs.writeFileString(join(created.path, "new.txt"), "untracked\n");
				yield* workspaces.archive(created.id, { force: true });
				const restored = yield* workspaces.unarchive(created.id);
				return {
					restored,
					readme: yield* fs.readFileString(join(created.path, "README.md")),
					untracked: yield* fs.readFileString(join(created.path, "new.txt")),
					branch: yield* runGit(created.path, ["branch", "--show-current"]),
					stashes: yield* runGit(project.path, ["stash", "list"]),
				};
			}),
		);
		expect(result.restored).toMatchObject({ status: "active", archivedAt: null });
		expect(result.readme).toBe("edited\n");
		expect(result.untracked).toBe("untracked\n");
		expect(result.branch).toBe("feature");
		expect(result.stashes).toBe("");
	});

	test("keeps another workspace's archive stash", async () => {
		const stashes = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const first = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "first" });
				const second = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "second" });
				yield* fs.writeFileString(join(first.path, "a.txt"), "a\n");
				yield* fs.writeFileString(join(second.path, "b.txt"), "b\n");
				yield* workspaces.archive(first.id, { force: true });
				yield* workspaces.archive(second.id, { force: true });
				yield* workspaces.unarchive(first.id);
				return { list: yield* runGit(project.path, ["stash", "list", "--format=%s"]), second: second.id };
			}),
		);
		expect(stashes.list).toBe(`On second: octopus-archive/${stashes.second}`);
	});

	test("runs the setup script again, since ignored files were not kept", async () => {
		const runs = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir, "true");
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* waitForScriptRun(created.id);
				yield* workspaces.archive(created.id, { force: false });
				yield* workspaces.unarchive(created.id);
				yield* waitForScriptRun(created.id);
				return yield* workspaces.listScriptRuns(created.id);
			}),
		);
		expect(runs.map((run) => [run.kind, run.status])).toEqual([
			["setup", "completed"],
			["setup", "completed"],
		]);
	});

	test("does not start a setup script on restore where none ran before", async () => {
		const runs = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const projects = yield* ProjectService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* workspaces.archive(created.id, { force: false });
				// The script was added after the workspace was made, as for a fork's pull request it was skipped.
				yield* projects.updateScripts(project.id, { setupScript: "true", runScript: null });
				yield* workspaces.unarchive(created.id);
				return yield* workspaces.listScriptRuns(created.id);
			}),
		);
		expect(runs).toEqual([]);
	});

	test("refuses when the branch is gone, and leaves the workspace archived", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				yield* workspaces.archive(created.id, { force: false });
				yield* runGit(project.path, ["branch", "-D", "feature"]);
				const error = yield* Effect.flip(workspaces.unarchive(created.id));
				return { error, after: yield* workspaces.get(created.id) };
			}),
		);
		expect(result.error._tag).toBe("BranchNotFoundError");
		expect(result.after.status).toBe("archived");
	});

	test("flips an in-place workspace back, unless the project folder is active again", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspaces = yield* WorkspaceService;
				const project = yield* addProject(tempDir);
				const first = yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				yield* workspaces.archive(first.id, { force: false });
				const restored = yield* workspaces.unarchive(first.id);
				yield* workspaces.archive(first.id, { force: false });
				yield* workspaces.create({ kind: "inPlace", projectId: project.id });
				const refused = yield* Effect.flip(workspaces.unarchive(first.id));
				return { restored, refused };
			}),
		);
		expect(result.restored.status).toBe("active");
		expect(result.refused._tag).toBe("WorkspacePathInUseError");
	});
});
