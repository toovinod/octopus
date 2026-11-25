import { WorktreeRemoveError } from "@repo/contracts/Workspace";
import { resolveBranchRef } from "./createWorktree.ts";
import { runGit } from "../git/runGit.ts";
import { Effect } from "effect";

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
	// Ignored files such as .env are not stashed, so they go with the folder. Installed dependencies are meant to.
	const ignored = yield* runGit(worktreePath, [
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"--directory",
		"-z",
	]);
	const ignoredFiles = ignored.split("\0").filter((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry));
	return { changedFiles, unpushedCommits: Number(unpushed), ignoredFiles };
});

// The stash a forced archive leaves, found again by this message when the workspace is restored.
export const archiveStashMessage = (workspaceId: string) => `octopus-archive/${workspaceId}`;

const restoreStash = (worktreePath: string) =>
	runGit(worktreePath, ["stash", "pop", "--index"]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("Could not restore the stashed changes, they are still in git stash", cause),
		),
	);

// Removes the worktree folder and keeps its branch, so commits stay reachable.
// With `stashChanges`, uncommitted and untracked files are stashed first; stashes live in the
// shared repository, so they survive the folder.
export const removeWorktree = Effect.fn("removeWorktree")(function* (options: {
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly stashMessage: string | null;
}) {
	const { repositoryPath, worktreePath, stashMessage } = options;
	if (stashMessage !== null) {
		yield* runGit(worktreePath, ["stash", "push", "--include-untracked", "-m", stashMessage]);
		yield* Effect.logInfo("Stashed uncommitted changes before archiving").pipe(
			Effect.annotateLogs({ worktreePath, stashMessage }),
		);
	}
	// Forced, since git refuses any worktree with submodules otherwise. The caller has already checked for
	// unsaved work, or stashed it. A locked worktree still refuses.
	yield* runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("git worktree remove failed", cause).pipe(
				// The workspace stays active, so its changes go back into its folder.
				Effect.andThen(stashMessage === null ? Effect.void : restoreStash(worktreePath)),
				Effect.andThen(Effect.fail(new WorktreeRemoveError({ path: worktreePath }))),
			),
		),
	);
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
// cleanly, git leaves the conflicts in the folder and the stash stays, so nothing is lost.
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
		return;
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
		return;
	}
	const ref = (yield* stashFor("%gd")).find((fields) => fields[0] === sha)?.[1];
	if (ref !== undefined) {
		yield* runGit(worktreePath, ["stash", "drop", ref]);
	}
	yield* Effect.logInfo("Restored the changes stashed by the archive").pipe(
		Effect.annotateLogs({ worktreePath, message }),
	);
});
