import { runGit } from "../git/runGit.ts";
import { Effect } from "effect";

// A branch holding a fork's code keeps that mark in the repository's own git config, which code in a
// pull request cannot write. It outlives the workspace, so a branch kept by an archive stays untrusted
// when a new workspace uses it.
const forkKey = (branch: string) => `branch.${branch}.octopusFromFork`;

export const markForkBranch = Effect.fn("markForkBranch")(function* (repositoryPath: string, branch: string) {
	yield* runGit(repositoryPath, ["config", "--type=bool", forkKey(branch), "true"]);
});

export const isForkBranch = Effect.fn("isForkBranch")(function* (repositoryPath: string, branch: string) {
	const value = yield* runGit(repositoryPath, [
		"config",
		"--type=bool",
		"--default",
		"false",
		"--get",
		forkKey(branch),
	]);
	return value.trim() === "true";
});
