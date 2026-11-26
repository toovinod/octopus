import {
	BranchAlreadyExistsError,
	BranchCheckedOutError,
	BranchNotFoundError,
	WorktreeCreateError,
} from "@repo/contracts/Workspace";
import { runGit } from "../git/runGit.ts";
import { Effect, Hash } from "effect";

// show-ref exits 1 when the ref does not exist.
export const refExists = (repositoryPath: string, ref: string) =>
	runGit(repositoryPath, ["show-ref", "--verify", "--quiet", ref]).pipe(
		Effect.as(true),
		Effect.catchTag("GitCommandError", () => Effect.succeed(false)),
	);

// The full ref of a branch here, or else on origin, or null when neither has it.
export const resolveBranchRef = Effect.fn("resolveBranchRef")(function* (repositoryPath: string, branch: string) {
	for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
		if (yield* refExists(repositoryPath, ref)) return ref;
	}
	return null;
});

export const createWorktree = Effect.fn("createWorktree")(function* (options: {
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly branch: string;
	readonly baseBranch: string;
}) {
	const { repositoryPath, worktreePath, branch, baseBranch } = options;
	if (yield* refExists(repositoryPath, `refs/heads/${branch}`)) {
		return yield* new BranchAlreadyExistsError({ branch });
	}
	// A bare name that only origin has makes git check out a new local branch of that name instead of `branch`.
	const baseRef = yield* resolveBranchRef(repositoryPath, baseBranch);
	if (baseRef === null) {
		return yield* new BranchNotFoundError({ branch: baseBranch });
	}
	// No tracking: the workspace branch is new, and pushing sets its own upstream.
	yield* runGit(repositoryPath, ["worktree", "add", "--no-track", "-b", branch, worktreePath, baseRef]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("git worktree add failed", cause).pipe(
				Effect.andThen(Effect.fail(new WorktreeCreateError({ branch }))),
			),
		),
	);
});

// Checks out a branch that already exists. A branch only on origin gets a local branch that tracks it.
export const addBranchWorktree = Effect.fn("addBranchWorktree")(function* (options: {
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly branch: string;
}) {
	const { repositoryPath, worktreePath, branch } = options;
	const local = yield* refExists(repositoryPath, `refs/heads/${branch}`);
	if (!local && !(yield* refExists(repositoryPath, `refs/remotes/origin/${branch}`))) {
		return yield* new BranchNotFoundError({ branch });
	}
	const args = local
		? ["worktree", "add", worktreePath, branch]
		: ["worktree", "add", "--track", "-b", branch, worktreePath, `origin/${branch}`];
	yield* runGit(repositoryPath, args).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("git worktree add failed", cause).pipe(
				Effect.andThen(
					Effect.fail(
						// Git refuses a branch that another worktree, or the project folder, has checked out.
						/already (checked out|used by worktree)/.test(cause.stderr)
							? new BranchCheckedOutError({ branch })
							: new WorktreeCreateError({ branch }),
					),
				),
			),
		),
	);
});

const FOLDER_NAME_MAX_LENGTH = 63;

// A branch name as a folder name: workspace folders keep to the characters a workspace name allows. A branch
// that does not fit as it is gets a hash of its whole name, so `feat/x` and `feat-x`, or two long names that
// start alike, never share a folder.
export const worktreeFolderName = (branch: string) => {
	const cleaned = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
	if (cleaned === branch && branch.length <= FOLDER_NAME_MAX_LENGTH) {
		return branch;
	}
	const suffix = `-${(Hash.string(branch) >>> 0).toString(16).padStart(8, "0")}`;
	return `${(cleaned || "branch").slice(0, FOLDER_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
};
