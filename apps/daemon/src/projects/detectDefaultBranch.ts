import { DefaultBranchNotFoundError } from "@repo/contracts/Project";
import { resolveBranchRef } from "../workspaces/createWorktree.ts";
import { runGit } from "../git/runGit.ts";
import { Effect } from "effect";

// A git command that fails or prints nothing means "not set" here, so the next source is tried.
const readGit = (cwd: string, args: ReadonlyArray<string>) =>
	runGit(cwd, args).pipe(Effect.catchTag("GitCommandError", () => Effect.succeed("")));

export const detectDefaultBranch = Effect.fn("detectDefaultBranch")(
	function* (repositoryPath: string) {
		const originHead = yield* readGit(repositoryPath, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"refs/remotes/origin/HEAD",
		]);
		// A guess is used only when this repository has the branch, here or on origin.
		const exists = (branch: string) =>
			branch === ""
				? Effect.succeed(false)
				: Effect.map(resolveBranchRef(repositoryPath, branch), (ref) => ref !== null);
		const fromOrigin = originHead.replace(/^origin\//, "");
		if (yield* exists(fromOrigin)) {
			return fromOrigin;
		}

		yield* Effect.logWarning("origin/HEAD is not set, using init.defaultBranch as the default branch");
		const configured = yield* readGit(repositoryPath, ["config", "--get", "init.defaultBranch"]);
		if (yield* exists(configured)) {
			return configured;
		}

		yield* Effect.logWarning(
			"init.defaultBranch is not set or not a branch here, using the checked-out branch as the default branch",
		);
		const current = yield* readGit(repositoryPath, ["branch", "--show-current"]);
		if (current !== "") {
			return current;
		}
		return yield* new DefaultBranchNotFoundError({ path: repositoryPath });
	},
	(effect, repositoryPath) => effect.pipe(Effect.annotateLogs({ repositoryPath })),
);
