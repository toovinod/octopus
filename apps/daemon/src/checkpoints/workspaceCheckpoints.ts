import { isAbsolute, join } from "node:path";
import { newId } from "../database/newId.ts";
import { Effect, FileSystem } from "effect";
import { runGit } from "../git/runGit.ts";

// A checkpoint is a git tree of the workspace's files, not a commit: it needs no author and never touches
// the branch, the index or HEAD. Refs live in the repository, so all of a project's worktrees share them.
const workspaceRefs = (workspaceId: string) => `refs/octopus/checkpoints/${workspaceId}`;

export const checkpointRef = (workspaceId: string, sessionId: string, messageId: string) =>
	`${workspaceRefs(workspaceId)}/${sessionId}/${messageId}`;

// The files as they were just before the last revert, so a revert can be undone with git.
export const beforeRevertRef = (workspaceId: string, sessionId: string) =>
	`${workspaceRefs(workspaceId)}/${sessionId}/before-revert`;

export type CheckpointChange = "added" | "modified" | "deleted";

const gitPath = (worktree: string, name: string) =>
	runGit(worktree, ["rev-parse", "--git-path", name]).pipe(
		Effect.map((path) => (isAbsolute(path) ? path : join(worktree, path))),
	);

// Every file git would track, ignored ones left out. It hashes from a copy of the real index, so only
// files that changed since git last looked are read again.
const snapshotTree = Effect.fn("snapshotTree")(function* (worktree: string) {
	const fs = yield* FileSystem.FileSystem;
	const index = yield* gitPath(worktree, "index");
	const temporary = yield* gitPath(worktree, `octopus-index-${yield* newId}`);
	return yield* Effect.gen(function* () {
		if (yield* fs.exists(index)) yield* fs.copyFile(index, temporary);
		const env = { GIT_INDEX_FILE: temporary };
		yield* runGit(worktree, ["add", "--all"], env);
		return yield* runGit(worktree, ["write-tree"], env);
	}).pipe(Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))));
});

export const saveCheckpoint = Effect.fn("saveCheckpoint")(function* (worktree: string, ref: string) {
	yield* runGit(worktree, ["update-ref", ref, yield* snapshotTree(worktree)]);
});

// The checkpoint's tree, or null when there is none, as for a message sent before checkpoints existed.
export const findCheckpoint = Effect.fn("findCheckpoint")(function* (worktree: string, ref: string) {
	return yield* runGit(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]).pipe(
		Effect.catchTag("GitCommandError", () => Effect.succeed(null)),
	);
});

const splitNul = (output: string) => output.split("\0").filter((part) => part !== "");

const CHANGES: Record<string, CheckpointChange> = { A: "added", M: "modified", D: "deleted", T: "modified" };

// What changed since the checkpoint, so the user sees what a revert will undo. Also returns the tree of
// the files as they are now.
export const changesSince = Effect.fn("changesSince")(function* (worktree: string, checkpoint: string) {
	const now = yield* snapshotTree(worktree);
	const parts = splitNul(
		yield* runGit(worktree, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", checkpoint, now]),
	);
	const files: Array<{ readonly path: string; readonly change: CheckpointChange }> = [];
	for (let index = 0; index + 1 < parts.length; index += 2) {
		const status = parts[index] ?? "";
		const path = parts[index + 1] ?? "";
		files.push({ path, change: CHANGES[status] ?? "modified" });
	}
	return { now, files };
});

// Puts the files back as the tree has them and removes files made since. Ignored files stay as they are.
export const restoreCheckpoint = Effect.fn("restoreCheckpoint")(function* (worktree: string, checkpoint: string) {
	const fs = yield* FileSystem.FileSystem;
	const kept = new Set(splitNul(yield* runGit(worktree, ["ls-tree", "-r", "--name-only", "-z", checkpoint])));
	const current = splitNul(yield* runGit(worktree, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
	for (const path of current) {
		if (!kept.has(path)) yield* fs.remove(join(worktree, path), { force: true });
	}
	const temporary = yield* gitPath(worktree, `octopus-index-${yield* newId}`);
	yield* Effect.gen(function* () {
		const env = { GIT_INDEX_FILE: temporary };
		yield* runGit(worktree, ["read-tree", checkpoint], env);
		yield* runGit(worktree, ["checkout-index", "--all", "--force"], env);
	}).pipe(Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))));
});

export const deleteCheckpoints = Effect.fn("deleteCheckpoints")(function* (repository: string, workspaceId: string) {
	const refs = splitNul(
		yield* runGit(repository, ["for-each-ref", "--format=%(refname)%00", `${workspaceRefs(workspaceId)}/`]),
	);
	for (const ref of refs) {
		yield* runGit(repository, ["update-ref", "-d", ref.trim()]);
	}
});
