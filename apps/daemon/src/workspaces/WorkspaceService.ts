import {
	Workspace,
	WorkspaceArchivedError,
	WorkspaceHasUnsavedWorkError,
	WorkspaceNotFoundError,
	WorkspacePathInUseError,
	type WorktreeRemoveError,
} from "@repo/contracts/Workspace";
import {
	addArchivedWorktree,
	discardWorktree,
	dropArchiveHeadBranch,
	findUnsavedWork,
	isWorktreeOf,
	removeWorktree,
	restoreArchiveStash,
} from "./removeWorktree.ts";
import { RunScriptMissingError, ScriptRun, ScriptRunOutput, SetupScriptMissingError } from "@repo/contracts/ScriptRun";
import { Context, Duration, Effect, FiberMap, FileSystem, Layer, PubSub, Schedule, Semaphore, Stream } from "effect";
import { listBranches, listOpenIssues, listOpenPullRequests } from "./listWorkspaceSources.ts";
import { addBranchWorktree, createWorktree, worktreeFolderName } from "./createWorktree.ts";
import { applyScriptRunEvent, runSetupScript, setupRetryDelay } from "./runSetupScript.ts";
import { LocalDatabase, PRIVATE_DIRECTORY_MODE } from "../database/LocalDatabase.ts";
import { checkoutPullRequest, findPullRequestHead } from "./checkoutPullRequest.ts";
import { type GitCommandError, type GitSpawnError, runGit } from "../git/runGit.ts";
import { holdsForkCode, isForkBranch, markForkBranch } from "./forkBranch.ts";
import { deleteCheckpoints } from "../checkpoints/workspaceCheckpoints.ts";
import type { CreateWorkspaceInput } from "@repo/contracts/WorkspaceRpcs";
import { project, scriptRun, workspace } from "../database/schema.ts";
import { TerminalService } from "../terminals/TerminalService.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { SessionService } from "../sessions/SessionService.ts";
import { SetupScriptSettings } from "./SetupScriptSettings.ts";
import type { ScriptRunKind } from "@repo/contracts/ScriptRun";
import { listListeningPorts } from "./listListeningPorts.ts";
import type { GitTimeoutError } from "@repo/contracts/Git";
import type { ChildProcessSpawner } from "effect/process";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { ScriptRunChanges } from "./ScriptRunChanges.ts";
import type { Project } from "@repo/contracts/Project";
import { and, asc, eq, inArray } from "drizzle-orm";
import { basename, dirname, join } from "node:path";
import { WorkspaceLock } from "./WorkspaceLock.ts";
import type { SecureRandom } from "effect/crypto";
import { CappedOutput } from "./CappedOutput.ts";
import { runRunScript } from "./runRunScript.ts";
import { nowIso } from "../database/nowIso.ts";
import { newId } from "../database/newId.ts";

type WorkspaceRow = typeof workspace.$inferSelect;
type ScriptRunRow = typeof scriptRun.$inferInsert;
type ScriptServices =
	| LocalDatabase
	| ScriptRunChanges
	| ChildProcessSpawner.ChildProcessSpawner
	| SecureRandom.SecureRandom;

const UNFINISHED = ["pending", "processing"] as const;

// The kept tail of a run's output, plus live lines for clients following it.
// A null line marks the end of the run.
type LiveLine = { readonly index: number; readonly line: string | null };

interface ScriptOutput {
	readonly lines: CappedOutput;
	readonly live: PubSub.PubSub<LiveLine>;
	count: number;
	finished: boolean;
}

const RUN_SCRIPT_PORT_POLL = "2 seconds";

// A slow follower loses old lines rather than growing the daemon's memory: at most LIVE_LINES lines of at most
// LINE_MAX_LENGTH characters, about a megabyte.
export const LIVE_LINES = 1000;

// Finished output stays so the UI can show why a run failed, but only for the latest runs: a
// daemon that runs scripts for weeks would otherwise hold the output of every one.
export const MAX_FINISHED_OUTPUTS = 20;

// Setup scripts are usually installs, so only this many run at once, as after a restart that finds many pending.
export const SETUP_SCRIPTS_AT_ONCE = 2;

export class WorkspaceService extends Context.Service<WorkspaceService>()(
	"octopus/daemon/workspaces/WorkspaceService",
	{
		make: Effect.gen(function* () {
			const { dataDir } = yield* DaemonConfig;
			const database = yield* LocalDatabase;
			const projects = yield* ProjectService;
			const sessions = yield* SessionService;
			const terminals = yield* TerminalService;
			const workspaceLock = yield* WorkspaceLock;
			const scriptRunChanges = yield* ScriptRunChanges;
			const fs = yield* FileSystem.FileSystem;
			const services = yield* Effect.context<ScriptServices>();
			// One fiber per running script, interrupted when its workspace is archived
			// and when the daemon stops.
			const runningScripts = yield* FiberMap.make<string>();
			// Archiving runs git on the worktree folder, so two archives at once could both try to remove it.
			const archiveLock = yield* Semaphore.make(1);
			// Two quick clicks on Run or Run setup must not start a script twice.
			const runScriptLock = yield* Semaphore.make(1);
			const outputs = new Map<string, ScriptOutput>();
			// The process group of each running run script, by script run id, to find the ports it listens on.
			const runScriptGroups = new Map<string, number>();

			const startScript = Effect.fn("WorkspaceService.startScript")(function* (
				scriptRunId: string,
				job: (onLine: (line: string) => void) => Effect.Effect<void, unknown, ScriptServices>,
			) {
				const output: ScriptOutput = {
					lines: new CappedOutput(),
					live: yield* PubSub.sliding<LiveLine>(LIVE_LINES),
					count: 0,
					finished: false,
				};
				outputs.set(scriptRunId, output);
				const publish = (line: string | null) => {
					output.count++;
					PubSub.publishUnsafe(output.live, { index: output.count, line });
				};
				const onLine = (line: string) => {
					output.lines.append(line);
					publish(line);
				};
				return yield* FiberMap.run(
					runningScripts,
					scriptRunId,
					job(onLine).pipe(
						Effect.catch((error) => Effect.logError("Script job stopped", error)),
						Effect.ensuring(
							Effect.sync(() => {
								output.finished = true;
								const finished = [...outputs].filter(([, kept]) => kept.finished);
								for (const [id] of finished.slice(0, -MAX_FINISHED_OUTPUTS)) outputs.delete(id);
								// Last: a follower waiting on the end resumes inside this call.
								publish(null);
							}),
						),
						Effect.provide(services),
					),
				);
			});

			const setupPermits = yield* Semaphore.make(SETUP_SCRIPTS_AT_ONCE);
			// The run stays pending while it waits out `delay` or a free permit.
			const startSetupScript = (scriptRunId: string, script: string, cwd: string, delay = Duration.zero) =>
				startScript(scriptRunId, (onLine) =>
					Effect.sleep(delay).pipe(
						Effect.andThen(runSetupScript({ scriptRunId, script, cwd, onLine, permits: setupPermits })),
					),
				);

			const insertWorkspace = (row: WorkspaceRow, setupRun: ScriptRunRow | null) =>
				database.query((db) =>
					db.transaction((tx) =>
						Effect.gen(function* () {
							const taken = yield* tx.$count(
								workspace,
								and(eq(workspace.path, row.path), eq(workspace.status, "active")),
							);
							if (taken > 0) {
								return false;
							}
							yield* tx.insert(workspace).values(row);
							if (setupRun !== null) {
								yield* tx.insert(scriptRun).values(setupRun);
							}
							return true;
						}),
					),
				);

			const isPathActive = (path: string) =>
				database
					.query((db) => db.$count(workspace, and(eq(workspace.path, path), eq(workspace.status, "active"))))
					.pipe(Effect.map((count) => count > 0));

			// Where a worktree workspace's code comes from: a new branch, one that exists, or a pull request.
			// `ownsBranch` says whether the branch was made for the workspace, so undoing the worktree may delete it.
			// `fromFork` marks a fork's pull request. Its setup script (an install, say) would run code that anyone
			// on GitHub can write, so the user starts it once they have read the change, and its agents never get
			// the project's trust.
			const planWorktree = Effect.fn("WorkspaceService.planWorktree")(function* (
				owner: Project,
				input: Exclude<CreateWorkspaceInput, { readonly kind: "inPlace" }>,
			) {
				switch (input.kind) {
					case "worktree": {
						const baseBranch = input.baseBranch ?? owner.defaultBranch;
						return {
							branch: input.name,
							baseBranch,
							ownsBranch: true,
							// A new branch from a fork's branch starts with the fork's code.
							fromFork: yield* isForkBranch(owner.path, baseBranch),
							add: (worktreePath: string) =>
								createWorktree({ repositoryPath: owner.path, worktreePath, branch: input.name, baseBranch }),
						};
					}
					case "branch":
						return {
							branch: input.branch,
							baseBranch: owner.defaultBranch,
							ownsBranch: false,
							fromFork: yield* isForkBranch(owner.path, input.branch),
							add: (worktreePath: string) =>
								addBranchWorktree({ repositoryPath: owner.path, worktreePath, branch: input.branch }),
						};
					case "pullRequest": {
						const head = yield* findPullRequestHead(owner.path, input.number);
						return {
							branch: head.branch,
							baseBranch: head.baseBranch,
							ownsBranch: false,
							fromFork: head.fromFork,
							add: (worktreePath: string) =>
								checkoutPullRequest({
									repositoryPath: owner.path,
									worktreePath,
									number: input.number,
									branch: head.branch,
								}),
						};
					}
				}
			});

			// The worktrees folder holds checked-out code, so it is as private as the data dir.
			const worktreesDir = join(dataDir, "worktrees");
			const makeWorktreesDir = fs
				.makeDirectory(worktreesDir, {
					recursive: true,
					mode: PRIVATE_DIRECTORY_MODE,
				})
				.pipe(Effect.andThen(fs.chmod(worktreesDir, PRIVATE_DIRECTORY_MODE)), Effect.orDie);

			const newSetupRun = Effect.fn("WorkspaceService.newSetupRun")(function* (workspaceId: string) {
				const now = yield* nowIso;
				return {
					id: yield* newId,
					workspaceId,
					kind: "setup",
					status: "pending",
					attempts: 0,
					lastError: null,
					exitCode: null,
					createdAt: now,
					updatedAt: now,
					startedAt: null,
					finishedAt: null,
				} satisfies ScriptRunRow;
			});

			const create = Effect.fn("WorkspaceService.create")(function* (input: CreateWorkspaceInput) {
				const owner = yield* projects.get(input.projectId);
				const now = yield* nowIso;
				const id = yield* newId;
				const base = {
					id,
					projectId: owner.id,
					status: "active",
					pullRequestUrl: null,
					fromFork: false,
					createdAt: now,
					archivedAt: null,
				} as const;

				let row: WorkspaceRow;
				let setupRun: ScriptRunRow | null = null;
				let ownsBranch = false;
				if (input.kind !== "inPlace") {
					const plan = yield* planWorktree(owner, input);
					ownsBranch = plan.ownsBranch;
					// Keyed by project id: two repositories can share a folder name. The UI shows the workspace name.
					const path = join(worktreesDir, owner.id, worktreeFolderName(plan.branch));
					// Checked before git touches the disk, so the user gets a clear error.
					if (yield* isPathActive(path)) {
						return yield* new WorkspacePathInUseError({ path });
					}
					yield* makeWorktreesDir;
					yield* plan.add(path);
					row = {
						...base,
						name: plan.branch,
						kind: "worktree",
						path,
						branch: plan.branch,
						baseBranch: plan.baseBranch,
						fromFork: plan.fromFork,
					};
					setupRun = plan.fromFork || owner.setupScript === null ? null : yield* newSetupRun(id);
				} else {
					const current = yield* runGit(owner.path, ["branch", "--show-current"]);
					row = {
						...base,
						name: owner.name,
						kind: "inPlace",
						path: owner.path,
						// An empty answer means a detached HEAD.
						branch: current === "" ? "HEAD" : current,
						baseBranch: owner.defaultBranch,
					};
				}

				// Marked under the same undo as the insert, so a failed mark leaves no unmarked worktree behind.
				yield* (row.fromFork ? markForkBranch(owner.path, row.branch) : Effect.void).pipe(
					Effect.andThen(insertWorkspace(row, setupRun)),
					Effect.flatMap((inserted) =>
						inserted ? Effect.void : Effect.fail(new WorkspacePathInUseError({ path: row.path })),
					),
					Effect.onError(() =>
						row.kind === "worktree"
							? discardWorktree({
									repositoryPath: owner.path,
									worktreePath: row.path,
									branch: ownsBranch ? row.branch : null,
								})
							: Effect.void,
					),
				);
				yield* Effect.logInfo("Created workspace").pipe(
					Effect.annotateLogs({
						workspaceId: id,
						kind: row.kind,
						path: row.path,
					}),
				);
				if (setupRun !== null && owner.setupScript !== null) {
					// Never block the RPC on the script.
					yield* startSetupScript(setupRun.id, owner.setupScript, row.path);
				}
				return yield* withForkState(row);
			}, Effect.provide(services));

			// What a new workspace can start from, read from the project's repository and its GitHub remote.
			const listProjectBranches = Effect.fn("WorkspaceService.listProjectBranches")(function* (projectId: string) {
				return yield* listBranches((yield* projects.get(projectId)).path);
			}, Effect.provide(services));

			const listProjectPullRequests = Effect.fn("WorkspaceService.listProjectPullRequests")(function* (
				projectId: string,
			) {
				return yield* listOpenPullRequests((yield* projects.get(projectId)).path);
			}, Effect.provide(services));

			const listProjectIssues = Effect.fn("WorkspaceService.listProjectIssues")(function* (projectId: string) {
				return yield* listOpenIssues((yield* projects.get(projectId)).path);
			}, Effect.provide(services));

			const get = Effect.fn("WorkspaceService.get")(function* (workspaceId: string) {
				const [row] = yield* database.query((db) => db.select().from(workspace).where(eq(workspace.id, workspaceId)));
				if (row === undefined) {
					return yield* new WorkspaceNotFoundError({ workspaceId });
				}
				return new Workspace(row);
			});

			// What the UI is sent. An active workspace's folder may have switched to a fork's branch since it was made, as
			// with `gh pr checkout` in an in-place workspace, so its fork state is read again.
			const withForkState = (row: WorkspaceRow) =>
				(row.status === "active" ? holdsForkCode(row) : Effect.succeed(row.fromFork)).pipe(
					Effect.map((fromFork) => new Workspace({ ...row, fromFork })),
					Effect.provide(services),
				);

			const list = (projectId: string) =>
				database
					.query((db) =>
						db.select().from(workspace).where(eq(workspace.projectId, projectId)).orderBy(asc(workspace.createdAt)),
					)
					// Each active workspace runs a few git commands, so a long list does not start them all at once.
					.pipe(Effect.flatMap((rows) => Effect.forEach(rows, withForkState, { concurrency: 8 })));

			const cancelScripts = Effect.fn("WorkspaceService.cancelScripts")(function* (
				workspaceId: string,
				reason: string,
				kinds: ReadonlyArray<ScriptRunKind> = ["setup", "run"],
			) {
				const unfinished = yield* database.query((db) =>
					db
						.select({ id: scriptRun.id })
						.from(scriptRun)
						.where(
							and(
								eq(scriptRun.workspaceId, workspaceId),
								inArray(scriptRun.status, UNFINISHED),
								inArray(scriptRun.kind, kinds),
							),
						),
				);
				// At once: a script that ignores its stop signal takes the whole stop grace.
				yield* Effect.forEach(
					unfinished,
					(run) =>
						FiberMap.remove(runningScripts, run.id).pipe(
							Effect.andThen(applyScriptRunEvent(run.id, { _tag: "Cancelled", reason })),
							// The script finished on its own between the query and the interrupt.
							Effect.catchTag("IllegalJobTransitionError", (error) =>
								Effect.logDebug("Script run ended before it was cancelled", error),
							),
						),
					{ concurrency: "unbounded", discard: true },
				);
			}, Effect.provide(services));

			// Agents, terminals and scripts all run in the workspace folder, so they stop before it can be
			// removed. Only once archiving goes ahead: a refused archive leaves them running.
			const stopWorkspaceProcesses = (workspaceId: string) =>
				Effect.all(
					[
						sessions.stopWorkspace(workspaceId),
						terminals.closeWorkspace(workspaceId),
						cancelScripts(workspaceId, "The workspace was archived."),
					],
					{ concurrency: "unbounded", discard: true },
				);

			const archive = Effect.fn("WorkspaceService.archive")(
				function* (workspaceId: string, options: { readonly force: boolean }) {
					const current = yield* get(workspaceId);
					if (current.status === "archived") {
						return current;
					}
					// What takes the workspace's folder away. It runs with the rest of the archive, below.
					let remove: Effect.Effect<
						void,
						WorktreeRemoveError | GitCommandError | GitSpawnError | GitTimeoutError,
						ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
					> = Effect.void;
					if (current.kind === "worktree") {
						// The foreign key keeps the project while it has workspaces.
						const owner = yield* projects
							.get(current.projectId)
							.pipe(Effect.catchTag("ProjectNotFoundError", Effect.die));
						const isWorktree =
							(yield* fs.exists(current.path).pipe(Effect.orDie)) &&
							(yield* isWorktreeOf(owner.path, yield* fs.realPath(current.path).pipe(Effect.orDie)));
						if (isWorktree) {
							const refuseUnsaved = Effect.fnUntraced(function* () {
								const unsaved = yield* findUnsavedWork(current.path, current.baseBranch);
								const hasUnsaved =
									unsaved.changedFiles.length > 0 || unsaved.unpushedCommits > 0 || unsaved.ignoredFiles.length > 0;
								if (hasUnsaved && !options.force) {
									return yield* new WorkspaceHasUnsavedWorkError({
										workspaceId,
										...unsaved,
									});
								}
								return unsaved;
							});
							// Checked before stopping, so a refused archive leaves the agents running.
							yield* refuseUnsaved();
							yield* stopWorkspaceProcesses(workspaceId);
							// And again after: agents and scripts can write files until they stop.
							const unsaved = yield* refuseUnsaved();
							remove = removeWorktree({
								repositoryPath: owner.path,
								worktreePath: current.path,
								workspaceId,
								stashChanges: unsaved.changedFiles.length > 0,
							});
						} else {
							// Someone deleted the folder, or what links it to the repository, already. Forget it in git and
							// carry on. A folder that is left holds files git no longer knows, so it stays for the user.
							yield* Effect.logWarning("Worktree folder is missing or no longer a worktree, pruning it").pipe(
								Effect.annotateLogs({ workspaceId, path: current.path }),
							);
							yield* stopWorkspaceProcesses(workspaceId);
							remove = runGit(owner.path, ["worktree", "prune"]).pipe(Effect.asVoid);
						}
					} else {
						// In place: the folder is the project itself, so nothing is removed.
						yield* stopWorkspaceProcesses(workspaceId);
					}

					const markArchived = Effect.gen(function* () {
						const archivedAt = yield* nowIso;
						yield* database.query((db) =>
							db.update(workspace).set({ status: "archived", archivedAt }).where(eq(workspace.id, workspaceId)),
						);
						yield* sessions.deleteWorkspaceAttachments(workspaceId);
						// Checkpoints keep old copies of files alive in git, so they go with the workspace.
						const { path: repository } = yield* projects
							.get(current.projectId)
							.pipe(Effect.catchTag("ProjectNotFoundError", Effect.die));
						yield* deleteCheckpoints(repository, workspaceId).pipe(
							Effect.catch((cause) => Effect.logWarning("Could not delete the workspace's checkpoints", cause)),
						);
						const runs = yield* listScriptRuns(workspaceId);
						for (const run of runs) {
							outputs.delete(run.id);
						}
					});
					// Not cut short by a quit or a dropped connection: stopped between stashing and saving the row, the
					// workspace would stay active with its changes only in a stash. Each git command keeps its deadline,
					// and a failed removal puts the stash back.
					yield* Effect.uninterruptible(remove.pipe(Effect.andThen(markArchived)));
					yield* Effect.logInfo("Archived workspace").pipe(Effect.annotateLogs({ workspaceId }));
					return yield* get(workspaceId);
				},
				(effect, workspaceId) => workspaceLock.archiving(workspaceId, effect),
				Semaphore.withPermit(archiveLock),
				Effect.provide(services),
			);

			// Undoes an archive. A worktree comes back from its kept branch, with the changes a forced archive
			// stashed. Another active workspace may have taken the folder meanwhile, which the partial unique index
			// on active paths forbids, so that is checked first and again when the row flips.
			const unarchive = Effect.fn("WorkspaceService.unarchive")(
				function* (workspaceId: string) {
					const current = yield* get(workspaceId);
					if (current.status === "active") {
						return yield* withForkState(current);
					}
					if (yield* isPathActive(current.path)) {
						return yield* new WorkspacePathInUseError({ path: current.path });
					}
					// The foreign key keeps the project while it has workspaces.
					const owner = yield* projects
						.get(current.projectId)
						.pipe(Effect.catchTag("ProjectNotFoundError", Effect.die));
					let setupRun: ScriptRunRow | null = null;
					let detached = false;
					if (current.kind === "worktree") {
						yield* makeWorktreesDir;
						detached = yield* addArchivedWorktree({
							repositoryPath: owner.path,
							worktreePath: current.path,
							workspaceId,
							branch: current.branch,
						});
						// Ignored files such as installed dependencies were not kept, so setup runs again. Only where it ran
						// before: a fork's pull request never ran it, and restoring must not start it on that code either.
						const setupBefore = yield* database.query((db) =>
							db.$count(scriptRun, and(eq(scriptRun.workspaceId, workspaceId), eq(scriptRun.kind, "setup"))),
						);
						setupRun = setupBefore > 0 && owner.setupScript !== null ? yield* newSetupRun(workspaceId) : null;
					}
					// The project can be removed meanwhile, with this workspace still archived, which deletes its row.
					const outcome = yield* database.query((db) =>
						db.transaction((tx) =>
							Effect.gen(function* () {
								const archived = yield* tx.$count(
									workspace,
									and(eq(workspace.id, workspaceId), eq(workspace.status, "archived")),
								);
								if (archived === 0) {
									return "gone" as const;
								}
								const taken = yield* tx.$count(
									workspace,
									and(eq(workspace.path, current.path), eq(workspace.status, "active")),
								);
								if (taken > 0) {
									return "pathInUse" as const;
								}
								yield* tx
									.update(workspace)
									.set({ status: "active", archivedAt: null })
									.where(eq(workspace.id, workspaceId));
								if (setupRun !== null) {
									yield* tx.insert(scriptRun).values(setupRun);
								}
								return "restored" as const;
							}),
						),
					);
					if (outcome !== "restored") {
						if (current.kind === "worktree") {
							yield* discardWorktree({ repositoryPath: owner.path, worktreePath: current.path, branch: null });
						}
						return yield* outcome === "gone"
							? new WorkspaceNotFoundError({ workspaceId })
							: new WorkspacePathInUseError({ path: current.path });
					}
					if (current.kind === "worktree") {
						const clean = yield* restoreArchiveStash(current.path, workspaceId);
						if (clean && detached) {
							yield* dropArchiveHeadBranch(owner.path, workspaceId);
						}
					}
					yield* Effect.logInfo("Restored workspace").pipe(Effect.annotateLogs({ workspaceId }));
					if (setupRun !== null && owner.setupScript !== null) {
						yield* startSetupScript(setupRun.id, owner.setupScript, current.path);
					}
					return yield* withForkState(yield* get(workspaceId));
				},
				(effect, workspaceId) => workspaceLock.restoring(workspaceId, effect),
				Semaphore.withPermit(archiveLock),
				Effect.provide(services),
			);

			const listScriptRuns = (workspaceId: string) =>
				database
					.query((db) =>
						db.select().from(scriptRun).where(eq(scriptRun.workspaceId, workspaceId)).orderBy(asc(scriptRun.createdAt)),
					)
					.pipe(Effect.map((rows) => rows.map((row) => new ScriptRun(row))));

			const getScriptRunOutput = (scriptRunId: string) =>
				new ScriptRunOutput({
					scriptRunId,
					output: outputs.get(scriptRunId)?.lines.toString() ?? "",
				});

			// The kept output as one chunk, then each new line, until the run ends.
			const followScriptRunOutput = (scriptRunId: string): Stream.Stream<string> =>
				Stream.unwrap(
					Effect.gen(function* () {
						const output = outputs.get(scriptRunId);
						if (output === undefined) {
							return Stream.empty;
						}
						// Subscribe before the snapshot, then skip the lines it already holds.
						const subscription = yield* PubSub.subscribe(output.live);
						const snapshotIndex = output.count;
						const snapshot = output.lines.toString();
						const kept = snapshot === "" ? Stream.empty : Stream.succeed(snapshot);
						if (output.finished) {
							return kept;
						}
						return Stream.concat(
							kept,
							Stream.fromSubscription(subscription).pipe(
								Stream.filter((item) => item.index > snapshotIndex),
								Stream.takeWhile((item) => item.line !== null),
								Stream.map((item) => item.line ?? ""),
							),
						);
					}),
				);

			const findRunningRunScript = (workspaceId: string) =>
				database
					.query((db) =>
						db
							.select()
							.from(scriptRun)
							.where(
								and(
									eq(scriptRun.workspaceId, workspaceId),
									eq(scriptRun.kind, "run"),
									inArray(scriptRun.status, UNFINISHED),
								),
							),
					)
					.pipe(Effect.map(([row]) => (row === undefined ? null : new ScriptRun(row))));

			const startRunScript = Effect.fn("WorkspaceService.startRunScript")(
				function* (workspaceId: string) {
					const current = yield* get(workspaceId);
					if (current.status === "archived") {
						return yield* new WorkspaceArchivedError({ workspaceId });
					}
					const owner = yield* projects.get(current.projectId);
					const script = owner.runScript;
					if (script === null) {
						return yield* new RunScriptMissingError({ projectId: owner.id });
					}
					const running = yield* findRunningRunScript(workspaceId);
					if (running !== null) {
						return running;
					}
					const now = yield* nowIso;
					const scriptRunId = yield* newId;
					yield* database.query((db) =>
						db.insert(scriptRun).values({
							id: scriptRunId,
							workspaceId,
							kind: "run",
							status: "pending",
							attempts: 0,
							createdAt: now,
							updatedAt: now,
						}),
					);
					yield* startScript(scriptRunId, (onLine) =>
						runRunScript({
							scriptRunId,
							script,
							cwd: current.path,
							onLine,
							onSpawn: (pid) => runScriptGroups.set(scriptRunId, pid),
						}).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									runScriptGroups.delete(scriptRunId);
									portLooks.delete(scriptRunId);
								}),
							),
						),
					);
					yield* Effect.logInfo("Started run script").pipe(Effect.annotateLogs({ workspaceId, scriptRunId }));
					return new ScriptRun({
						id: scriptRunId,
						workspaceId,
						kind: "run",
						status: "pending",
						attempts: 0,
						lastError: null,
						exitCode: null,
						createdAt: now,
						updatedAt: now,
						startedAt: null,
						finishedAt: null,
					});
				},
				Semaphore.withPermit(runScriptLock),
				// Outside the run script lock, so an archive holding one workspace never blocks the others.
				(effect, workspaceId) => workspaceLock.starting(workspaceId, effect),
				Effect.provide(services),
			);

			// The user's explicit start, the only way a fork's setup script runs. A failed run starts over.
			const startSetupScriptRun = Effect.fn("WorkspaceService.startSetupScriptRun")(
				function* (workspaceId: string) {
					const current = yield* get(workspaceId);
					if (current.status === "archived") {
						return yield* new WorkspaceArchivedError({ workspaceId });
					}
					const owner = yield* projects.get(current.projectId);
					const script = owner.setupScript;
					if (script === null) {
						return yield* new SetupScriptMissingError({ projectId: owner.id });
					}
					const last = (yield* listScriptRuns(workspaceId)).filter((run) => run.kind === "setup").at(-1);
					if (last !== undefined && (last.status === "pending" || last.status === "processing")) {
						return last;
					}
					let run: ScriptRun;
					if (last !== undefined && (last.status === "failed" || last.status === "deadLetter")) {
						run = new ScriptRun({ ...last, ...(yield* applyScriptRunEvent(last.id, { _tag: "Retried" })) });
					} else {
						const setupRun = yield* newSetupRun(workspaceId);
						yield* database.query((db) => db.insert(scriptRun).values(setupRun));
						run = new ScriptRun(setupRun);
					}
					yield* startSetupScript(run.id, script, current.path);
					yield* Effect.logInfo("Started setup script").pipe(Effect.annotateLogs({ workspaceId, scriptRunId: run.id }));
					return run;
				},
				Semaphore.withPermit(runScriptLock),
				(effect, workspaceId) => workspaceLock.starting(workspaceId, effect),
				Effect.provide(services),
			);

			// Each look spawns pgrep and lsof, so every watcher of a run, one per open window, shares the latest one.
			const portLooks = new Map<string, Effect.Effect<ReadonlyArray<number>>>();
			const readRunScriptPorts = Effect.fn("WorkspaceService.readRunScriptPorts")(function* (workspaceId: string) {
				const running = yield* findRunningRunScript(workspaceId);
				const group = running === null ? undefined : runScriptGroups.get(running.id);
				if (running === null || group === undefined) {
					return [];
				}
				let look = portLooks.get(running.id);
				if (look === undefined) {
					look = yield* Effect.cachedWithTTL(
						listListeningPorts(group).pipe(Effect.provide(services)),
						RUN_SCRIPT_PORT_POLL,
					);
					portLooks.set(running.id, look);
				}
				return yield* look;
			}, Effect.provide(services));

			// The ports the workspace's run script listens on, sent again each time they change. A dev server
			// takes a moment to bind, and can move ports when one is taken, so this keeps looking.
			const watchRunScriptPorts = (workspaceId: string) =>
				Stream.fromEffectSchedule(readRunScriptPorts(workspaceId), Schedule.spaced(RUN_SCRIPT_PORT_POLL)).pipe(
					Stream.changesWith((a, b) => a.join() === b.join()),
				);

			const watchScriptRuns = (workspaceId: string): Stream.Stream<ScriptRun> =>
				Stream.fromPubSub(scriptRunChanges).pipe(Stream.filter((run) => run.workspaceId === workspaceId));

			const stopRunScript = (workspaceId: string) => cancelScripts(workspaceId, "Stopped.", ["run"]);

			const setPullRequestUrl = Effect.fn("WorkspaceService.setPullRequestUrl")(function* (
				workspaceId: string,
				pullRequestUrl: string,
			) {
				yield* database.query((db) =>
					db.update(workspace).set({ pullRequestUrl }).where(eq(workspace.id, workspaceId)),
				);
				return yield* get(workspaceId);
			});

			// Startup recovery: runs left in processing were cut off by a restart, which is a
			// retryable failure. Then every pending run of an active workspace starts again.
			const recoverScriptRuns = Effect.gen(function* () {
				const { maxAttempts, retryBaseDelay } = yield* SetupScriptSettings;
				const cutOff = yield* database.query((db) =>
					db
						.select({ id: scriptRun.id, kind: scriptRun.kind })
						.from(scriptRun)
						.where(eq(scriptRun.status, "processing")),
				);
				for (const run of cutOff) {
					yield* applyScriptRunEvent(
						run.id,
						run.kind === "setup"
							? {
									_tag: "FailedRetryably",
									error: "The daemon restarted while the setup script was running.",
									maxAttempts,
								}
							: // The user starts run scripts, so a restart stops them instead of running them again.
								{ _tag: "Cancelled", reason: "The daemon restarted, so the run script stopped." },
					);
				}
				const pending = yield* database.query((db) =>
					db
						.select({
							id: scriptRun.id,
							kind: scriptRun.kind,
							attempts: scriptRun.attempts,
							path: workspace.path,
							workspaceStatus: workspace.status,
							script: project.setupScript,
						})
						.from(scriptRun)
						.innerJoin(workspace, eq(scriptRun.workspaceId, workspace.id))
						.innerJoin(project, eq(workspace.projectId, project.id))
						.where(eq(scriptRun.status, "pending")),
				);
				for (const run of pending) {
					if (run.kind === "setup" && run.workspaceStatus === "active" && run.script !== null) {
						// A run that already failed waits out the retry delay it would have had, rather than starting at once.
						const delay = run.attempts === 0 ? Duration.zero : yield* setupRetryDelay(retryBaseDelay, run.attempts);
						yield* startSetupScript(run.id, run.script, run.path, delay);
					} else {
						yield* applyScriptRunEvent(run.id, {
							_tag: "Cancelled",
							reason: "The workspace was archived or its setup script removed.",
						});
					}
				}
				if (cutOff.length > 0 || pending.length > 0) {
					yield* Effect.logInfo("Recovered setup scripts after a restart").pipe(
						Effect.annotateLogs({
							cutOff: cutOff.length,
							resumed: pending.length,
						}),
					);
				}
			});
			yield* recoverScriptRuns.pipe(Effect.provide(services));

			const pruneProjectWorktrees = Effect.fnUntraced(function* (owner: Project, ownedPaths: ReadonlySet<string>) {
				const folder = join(worktreesDir, owner.id);
				if (!(yield* fs.exists(folder))) return;
				const realFolder = yield* fs.realPath(folder);
				const listed = yield* runGit(owner.path, ["worktree", "list", "--porcelain"]);
				for (const line of listed.split("\n")) {
					if (!line.startsWith("worktree ")) continue;
					const path = line.slice("worktree ".length);
					if (!(yield* fs.exists(path)) || (yield* fs.realPath(dirname(path))) !== realFolder) continue;
					// Rows hold the path Octopus made, which git may list with symlinks resolved.
					if (ownedPaths.has(join(folder, basename(path)))) continue;
					yield* runGit(owner.path, ["worktree", "remove", "--force", path]);
					yield* Effect.logWarning("Removed a worktree that no workspace owns").pipe(Effect.annotateLogs({ path }));
				}
			});

			// A crash between adding a worktree and saving its workspace leaves a folder that no workspace owns and
			// that blocks its name. Nothing ran in it yet, so it goes. Its branch stays, in case it holds commits.
			const pruneOrphanWorktrees = Effect.gen(function* () {
				const owned = yield* database.query((db) =>
					db
						.select({ path: workspace.path })
						.from(workspace)
						.where(and(eq(workspace.kind, "worktree"), eq(workspace.status, "active"))),
				);
				const ownedPaths = new Set(owned.map((row) => row.path));
				for (const owner of yield* projects.list) {
					// Per project, so one whose folder is gone does not keep the others' orphans.
					const giveUp = (cause: unknown) =>
						Effect.logError("Could not look for worktrees that no workspace owns", cause).pipe(
							Effect.annotateLogs({ projectId: owner.id }),
						);
					yield* pruneProjectWorktrees(owner, ownedPaths).pipe(
						Effect.catchTags({
							PlatformError: giveUp,
							GitCommandError: giveUp,
							GitSpawnError: giveUp,
							GitTimeoutError: giveUp,
						}),
					);
				}
			});
			// Cleanup only frees folder names, so a database that cannot answer here does not keep the daemon from starting.
			yield* pruneOrphanWorktrees.pipe(
				Effect.catchTag("LocalDatabaseError", (cause) =>
					Effect.logWarning("Could not look for worktrees that no workspace owns", cause),
				),
				Effect.provide(services),
			);

			return {
				create,
				get,
				list,
				listProjectBranches,
				listProjectPullRequests,
				listProjectIssues,
				archive,
				unarchive,
				listScriptRuns,
				getScriptRunOutput,
				followScriptRunOutput,
				startRunScript,
				startSetupScriptRun,
				stopRunScript,
				watchScriptRuns,
				watchRunScriptPorts,
				setPullRequestUrl,
			};
		}),
	},
) {
	static readonly layer = Layer.effect(WorkspaceService, WorkspaceService.make);
}
