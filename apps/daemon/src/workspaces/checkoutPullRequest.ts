import { PullRequestCheckoutError, WorktreeCreateError } from "@repo/contracts/Workspace";
import { type GhCommandError, requireGhLogin, runGh } from "../git/runGh.ts";
import { runGit } from "../git/runGit.ts";
import { Effect, Schema } from "effect";

const GhPullRequestHead = Schema.fromJsonString(
	Schema.Struct({ headRefName: Schema.String, baseRefName: Schema.String, isCrossRepository: Schema.Boolean }),
);

const failCheckout = (repositoryPath: string, number: number) => (cause: GhCommandError | Schema.SchemaError) =>
	requireGhLogin(repositoryPath).pipe(
		Effect.andThen(Effect.logError("Could not read or check out the pull request", cause)),
		Effect.andThen(Effect.fail(new PullRequestCheckoutError({ number }))),
	);

// The local branch for a pull request and the branch it merges into. A fork's branch gets a name of its own,
// since a fork's "main" would otherwise land on the project's own main.
export const findPullRequestHead = Effect.fn("findPullRequestHead")(function* (repositoryPath: string, number: number) {
	const output = yield* runGh(repositoryPath, [
		"pr",
		"view",
		String(number),
		"--json",
		"headRefName,baseRefName,isCrossRepository",
	]).pipe(Effect.catchTag("GhCommandError", failCheckout(repositoryPath, number)));
	const head = yield* Schema.decodeUnknownEffect(GhPullRequestHead)(output).pipe(
		Effect.catchTag("SchemaError", failCheckout(repositoryPath, number)),
	);
	return {
		branch: head.isCrossRepository ? `pr-${number}-${head.headRefName}` : head.headRefName,
		baseBranch: head.baseRefName,
	};
});

// gh knows how to fetch a fork's head and set up pushing back to it, so it does the checkout. It needs a
// working tree to switch, so the worktree starts detached.
export const checkoutPullRequest = Effect.fn("checkoutPullRequest")(function* (options: {
	readonly repositoryPath: string;
	readonly worktreePath: string;
	readonly number: number;
	readonly branch: string;
}) {
	const { repositoryPath, worktreePath, number, branch } = options;
	yield* runGit(repositoryPath, ["worktree", "add", "--detach", worktreePath]).pipe(
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.logError("git worktree add failed", cause).pipe(
				Effect.andThen(Effect.fail(new WorktreeCreateError({ branch }))),
			),
		),
	);
	yield* runGh(worktreePath, ["pr", "checkout", String(number), "--branch", branch]).pipe(
		Effect.catchTag("GhCommandError", (cause) =>
			Effect.logError("gh pr checkout failed", cause).pipe(
				Effect.andThen(runGit(repositoryPath, ["worktree", "remove", "--force", worktreePath])),
				Effect.catchTag("GitCommandError", (removeCause) =>
					Effect.logError("Could not remove the worktree of a failed pull request checkout", removeCause),
				),
				Effect.andThen(Effect.fail(new PullRequestCheckoutError({ number }))),
			),
		),
	);
});
