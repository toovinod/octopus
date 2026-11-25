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

// Each checkpoint keeps old copies of files alive in git, so a session keeps only its latest ones.
export const CHECKPOINTS_PER_SESSION = 100;

export const saveCheckpoint = Effect.fn("saveCheckpoint")(function* (worktree: string, ref: string) {
	yield* runGit(worktree, ["update-ref", ref, yield* snapshotTree(worktree)]);
	// Message ids are UUIDv7, so the session's refs sort oldest first.
	const session = ref.slice(0, ref.lastIndexOf("/") + 1);
	const saved = splitNul(yield* runGit(worktree, ["for-each-ref", "--format=%(refname)%00", session]))
		.map((name) => name.trim())
		.filter((name) => name !== `${session}before-revert`)
		.sort();
	for (const old of saved.slice(0, -CHECKPOINTS_PER_SESSION)) {
		yield* runGit(worktree, ["update-ref", "-d", old]);
	}
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

// Writes the tree's files, then removes files made since. Ignored files stay as they are, judged by the
// .gitignore files just written back, so an agent that changed them cannot get .env or node_modules deleted.
const writeTree = Effect.fnUntraced(function* (worktree: string, tree: string) {
	const fs = yield* FileSystem.FileSystem;
	const temporary = yield* gitPath(worktree, `octopus-index-${yield* newId}`);
	yield* Effect.gen(function* () {
		const env = { GIT_INDEX_FILE: temporary };
		yield* runGit(worktree, ["read-tree", tree], env);
		yield* runGit(worktree, ["checkout-index", "--all", "--force"], env);
		// Untracked against the tree in the temporary index. A nested repository shows as its folder.
		const made = splitNul(yield* runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"], env));
		for (const path of made) {
			yield* fs.remove(join(worktree, path), { recursive: true, force: true });
		}
	}).pipe(Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))));
});

// Puts the files back as the checkpoint has them. A revert that fails partway puts back `before`, the files
// as they were, so the workspace is never left half reverted.
export const restoreCheckpoint = Effect.fn("restoreCheckpoint")(function* (
	worktree: string,
	checkpoint: string,
	before: string,
) {
	const giveUp = (cause: unknown) => Effect.logError("Could not undo a revert that failed partway", cause);
	yield* writeTree(worktree, checkpoint).pipe(
		Effect.onError(() =>
			writeTree(worktree, before).pipe(
				Effect.catchTags({
					GitCommandError: giveUp,
					GitSpawnError: giveUp,
					GitTimeoutError: giveUp,
					PlatformError: giveUp,
				}),
			),
		),
	);
	// Changes staged after the checkpoint would otherwise stay staged over the reverted files.
	const staged = splitNul(yield* runGit(worktree, ["diff-index", "--cached", "--name-only", "-z", checkpoint]));
	if (staged.length > 0) {
		yield* runGit(worktree, ["reset", "-q", "--", ...staged.map((path) => `:(literal)${path}`)]);
	}
});

export const deleteCheckpoints = Effect.fn("deleteCheckpoints")(function* (repository: string, workspaceId: string) {
	const refs = splitNul(
		yield* runGit(repository, ["for-each-ref", "--format=%(refname)%00", `${workspaceRefs(workspaceId)}/`]),
	);
	for (const ref of refs) {
		yield* runGit(repository, ["update-ref", "-d", ref.trim()]);
	}
});
