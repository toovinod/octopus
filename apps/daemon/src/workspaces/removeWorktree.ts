import { addBranchWorktree, refExists, resolveBranchRef } from "./createWorktree.ts";
import { WorktreeCreateError, WorktreeRemoveError } from "@repo/contracts/Workspace";
import { KeepThroughShutdown } from "../processes/ProcessRegistry.ts";
import { Array as Arr, Effect, FileSystem } from "effect";
import { runGit } from "../git/runGit.ts";
import { join } from "node:path";

// Folders that installs and builds fill, matched as the directory entries `git ls-files --directory` lists.
const REGENERABLE_FOLDER =
	/(^|\/)(node_modules|dist|build|\.next|\.turbo|target|\.venv|venv|__pycache__|\.cache|coverage|out)\/$/;

export const findUnsavedWork = Effect.fn("findUnsavedWork")(function* (worktreePath: string, baseBranch: string) {
	const status = yield* runGit(worktreePath, ["status", "--porcelain"]);
	// Each line is "XY path"; renames read "XY old -> new".
	const changedFiles = status === "" ? [] : status.split("\n").map((line) => line.slice(3));
	// Commits made in this workspace that no remote has. Base branch history is not this workspace's work.
	const base = yield* resolveBranchRef(worktreePath, baseBranch);
	if (base === null) {
		yield* Effect.logWarning("The base branch is gone, so every commit no remote has counts as unpushed").pipe(
			Effect.annotateLogs({ worktreePath, baseBranch }),
		);
	}
	const exclude = base === null ? [] : [`^${base}`];
	const unpushed = yield* runGit(worktreePath, ["rev-list", "--count", "HEAD", ...exclude, "--not", "--remotes"]);
	// Ignored files such as .env are not stashed, so they go with the folder. Installed dependencies and build
	// output are meant to, since an install or a build makes them again.
	const ignored = yield* runGit(worktreePath, [
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"--directory",
		"-z",
	]);
	const ignoredFiles = ignored.split("\0").filter((entry) => entry !== "" && !REGENERABLE_FOLDER.test(entry));
	return { changedFiles, unpushedCommits: Number(unpushed), ignoredFiles };
});

// Whether a folder is still a worktree of the repository, with `folder` as a real path. One whose `.git` is
// gone, or that now holds another repository, is not, and git would refuse to stash in or remove it. Any other
// failure, such as an unreadable `.git` or a safe.directory refusal, fails here: taken for "not a worktree", it
// would skip the unsaved-work check and leave the folder for start-up to delete.
export const isWorktreeOf = Effect.fn("isWorktreeOf")(function* (repositoryPath: string, folder: string) {
	const fs = yield* FileSystem.FileSystem;
	const locate = (cwd: string) =>
		runGit(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]).pipe(
			Effect.map((output) => output.split("\n")),
		);
	if (!(yield* fs.exists(join(folder, ".git")).pipe(Effect.orDie))) return false;
	const here = yield* locate(folder).pipe(
		Effect.catchTag("GitCommandError", (error) =>
			error.stderr.includes("not a git repository") ? Effect.succeed(null) : Effect.fail(error),
		),
	);
	if (here === null) return false;
	const [, repositoryCommonDir] = yield* locate(repositoryPath);
	return here[0] === folder && here[1] === repositoryCommonDir;
});

// The stash a forced archive leaves, found again by this message when the workspace is restored.
export const archiveStashMessage = (workspaceId: string) => `octopus-archive/${workspaceId}`;

// Commits made on a detached HEAD are on no branch, so removing the folder would leave them to git's garbage
// collection. They go on this branch instead.
export const archiveHeadBranch = (workspaceId: string) => `${archiveStashMessage(workspaceId)}-head`;

// Recreates an archived workspace's worktree where it was: detached at the commits the archive kept, when it was
// on a detached HEAD, so its stash applies onto the base it was made on. True when it is detached there.
export const addArchivedWorktree = Effect.fn("addArchivedWorktree")(function* (options: {
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly workspaceId: string;
	readonly branch: string;
}) {
	const { repositoryPath, worktreePath, workspaceId, branch } = options;
	const kept = archiveHeadBranch(workspaceId);
	if (!(yield* refExists(repositoryPath, `refs/heads/${kept}`))) {
		yield* addBranchWorktree({ repositoryPath, worktreePath, branch });
		return false;
	}
	yield* runGit(repositoryPath, ["worktree", "add", "--detach", worktreePath, kept]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("git worktree add failed", cause).pipe(
				Effect.andThen(Effect.fail(new WorktreeCreateError({ branch }))),
			),
		),
	);
	return true;
});

// Once a restore went cleanly, the branch the archive kept a detached HEAD's commits on has done its job: the
// worktree's HEAD holds them again, as it did before the archive.
export const dropArchiveHeadBranch = Effect.fn("dropArchiveHeadBranch")(function* (
	repositoryPath: string,
	workspaceId: string,
) {
	yield* runGit(repositoryPath, ["branch", "-D", archiveHeadBranch(workspaceId)]);
});

const keepDetachedCommits = Effect.fn("keepDetachedCommits")(function* (worktreePath: string, workspaceId: string) {
	const onBranch = yield* runGit(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]).pipe(
		Effect.as(true),
		Effect.catchTag("GitCommandError", () => Effect.succeed(false)),
	);
	if (onBranch) return;
	const unreachable = yield* runGit(worktreePath, [
		"rev-list",
		"--count",
		"HEAD",
		"--not",
		"--branches",
		"--tags",
		"--remotes",
	]);
	if (Number(unreachable) === 0) return;
	const branch = archiveHeadBranch(workspaceId);
	yield* runGit(worktreePath, ["branch", "--force", branch, "HEAD"]);
	yield* Effect.logWarning("Kept the commits of a detached HEAD on a branch before archiving").pipe(
		Effect.annotateLogs({ worktreePath, branch }),
	);
});

// Removes the worktree folder and keeps its branch, so commits stay reachable.
// With `stashChanges`, uncommitted and untracked files are stashed first; stashes live in the
// shared repository, so they survive the folder. If the folder cannot be removed, the stash goes back into it.
// Its git commands are kept through shutdown: one cut short mid-way could leave the folder half cleaned.
export const removeWorktree = Effect.fn("removeWorktree")(
	function* (options: {
		readonly repositoryPath: string;
		readonly worktreePath: string;
		readonly workspaceId: string;
		readonly stashChanges: boolean;
	}) {
		const { repositoryPath, worktreePath, workspaceId, stashChanges } = options;
		yield* keepDetachedCommits(worktreePath, workspaceId);
		if (stashChanges) {
			const before = yield* stashTip(worktreePath);
			yield* runGit(worktreePath, [
				"stash",
				"push",
				"--include-untracked",
				"-m",
				archiveStashMessage(workspaceId),
			]).pipe(
				// git saves the stash before it cleans the folder, so a push that fails or is killed can leave the
				// changes only in the stash, with the folder half cleaned.
				Effect.onError(() =>
					stashTip(worktreePath).pipe(
						Effect.flatMap((after) =>
							after === before ? Effect.void : putBackFailedStash(worktreePath, workspaceId, after),
						),
						Effect.catch((cause) =>
							Effect.logError(
								"Could not put back the changes a failed stash push saved, they are still in git stash",
								cause,
							),
						),
					),
				),
			);
			yield* Effect.logInfo("Stashed uncommitted changes before archiving").pipe(
				Effect.annotateLogs({ worktreePath, workspaceId }),
			);
		}
		// Forced, since git refuses any worktree with submodules otherwise. The caller has already checked for
		// unsaved work, or stashed it. A locked worktree still refuses.
		yield* runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]).pipe(
			// On any failure, not just git's refusal: the workspace stays active, so its changes go back into its folder.
			Effect.onError(() =>
				stashChanges
					? restoreArchiveStash(worktreePath, workspaceId).pipe(
							Effect.catch((cause) =>
								Effect.logError("Could not restore the stashed changes, they are still in git stash", cause),
							),
						)
					: Effect.void,
			),
			Effect.catchTag("GitCommandError", (cause) =>
				Effect.logError("git worktree remove failed", cause).pipe(
					Effect.andThen(Effect.fail(new WorktreeRemoveError({ path: worktreePath }))),
				),
			),
		);
	},
	Effect.provideService(KeepThroughShutdown, true),
);

const stashTip = (worktreePath: string) =>
	runGit(worktreePath, ["rev-parse", "--quiet", "--verify", "refs/stash"]).pipe(
		Effect.catchTag("GitCommandError", () => Effect.succeed("")),
	);

// Makes the folder and its index what the stash saved, whatever part of the cleaning git got through, then drops
// the stash. A plain `stash apply` refuses here, since files git did not get to clean are still changed.
const putBackFailedStash = Effect.fn("putBackFailedStash")(function* (
	worktreePath: string,
	workspaceId: string,
	sha: string,
) {
	// Another worktree's push may have moved the shared stash meanwhile.
	const subject = yield* runGit(worktreePath, ["log", "-1", "--format=%s", sha]);
	if (!subject.endsWith(`: ${archiveStashMessage(workspaceId)}`)) return;
	// Tracked files as the stash saved them, so a file the user deleted is deleted again.
	yield* runGit(worktreePath, ["restore", `--source=${sha}`, "--worktree", "--", "."]);
	const hasUntracked = yield* runGit(worktreePath, ["rev-parse", "--quiet", "--verify", `${sha}^3`]).pipe(
		Effect.as(true),
		Effect.catchTag("GitCommandError", () => Effect.succeed(false)),
	);
	if (hasUntracked) {
		// git cleans an untracked file by deleting it, so one still there is whole and only the deleted ones come back.
		const fs = yield* FileSystem.FileSystem;
		const saved = (yield* runGit(worktreePath, ["ls-tree", "-r", "-z", "--name-only", `${sha}^3`]))
			.split("\0")
			.filter((file) => file !== "");
		const missing = yield* Effect.filter(saved, (file) =>
			fs.exists(join(worktreePath, file)).pipe(Effect.map((there) => !there)),
		);
		yield* Effect.forEach(
			Arr.chunksOf(missing, 200),
			(files) => runGit(worktreePath, ["checkout", `${sha}^3`, "--", ...files], { GIT_LITERAL_PATHSPECS: "1" }),
			{ discard: true },
		);
	}
	// The index as it was, which also leaves the untracked files untracked again.
	yield* runGit(worktreePath, ["read-tree", `${sha}^2`]);
	yield* dropStash(worktreePath, sha);
	yield* Effect.logWarning("A stash push failed after saving the changes, so they were put back").pipe(
		Effect.annotateLogs({ worktreePath, workspaceId }),
	);
});

const dropStash = Effect.fn("dropStash")(function* (worktreePath: string, sha: string) {
	const list = yield* runGit(worktreePath, ["stash", "list", "--format=%H %gd"]);
	const ref = list
		.split("\n")
		.map((line) => line.split(" "))
		.find((fields) => fields[0] === sha)?.[1];
	if (ref !== undefined) {
		yield* runGit(worktreePath, ["stash", "drop", ref]);
	}
});

// Undoes adding a worktree when the workspace could not be saved. A branch the worktree created is new,
// so deleting it loses nothing; pass null for a branch that existed before, which stays.
// Failures are logged: the save error is the one the user needs to see.
export const discardWorktree = Effect.fn("discardWorktree")(
	function* (options: {
		readonly repositoryPath: string;
		readonly worktreePath: string;
		readonly branch: string | null;
	}) {
		const { repositoryPath, worktreePath, branch } = options;
		yield* runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]);
		if (branch !== null) {
			yield* runGit(repositoryPath, ["branch", "-D", branch]);
		}
		yield* Effect.logWarning("Removed the worktree of a workspace that could not be saved").pipe(
			Effect.annotateLogs({ worktreePath, branch }),
		);
	},
	Effect.catch((cause) => Effect.logError("Could not remove the worktree of an unsaved workspace", cause)),
);

// Puts back what a forced archive stashed, then drops the stash. Found by message and applied by sha, since
// other worktrees share the stash list and can shift its indexes meanwhile. If the changes do not apply
// cleanly, git leaves the conflicts in the folder and the stash stays, so nothing is lost. True when nothing is
// left in the stash.
export const restoreArchiveStash = Effect.fn("restoreArchiveStash")(function* (
	worktreePath: string,
	workspaceId: string,
) {
	const message = archiveStashMessage(workspaceId);
	const stashFor = (format: string) =>
		runGit(worktreePath, ["stash", "list", `--format=%H ${format}`]).pipe(
			Effect.map((list) => list.split("\n").map((line) => line.split(" "))),
		);
	// A stash subject reads "On <branch>: <message>".
	const entry = (yield* stashFor("%s")).find((fields) => fields.slice(1).join(" ").endsWith(`: ${message}`));
	const sha = entry?.[0];
	if (sha === undefined) {
		return true;
	}
	const applied = yield* runGit(worktreePath, ["stash", "apply", "--index", sha]).pipe(
		Effect.as(true),
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("The archived changes did not apply cleanly, they are still in git stash", cause).pipe(
				Effect.annotateLogs({ worktreePath, message }),
				Effect.as(false),
			),
		),
	);
	if (!applied) {
		return false;
	}
	const ref = (yield* stashFor("%gd")).find((fields) => fields[0] === sha)?.[1];
	if (ref !== undefined) {
		yield* runGit(worktreePath, ["stash", "drop", ref]);
	}
	yield* Effect.logInfo("Restored the changes stashed by the archive").pipe(
		Effect.annotateLogs({ worktreePath, message }),
	);
	return true;
});
