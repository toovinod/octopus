import { runGit } from "../git/runGit.ts";
import { Effect } from "effect";

// A branch holding a fork's code keeps that mark in the repository's own git config, which code in a
// pull request cannot write. It outlives the workspace, so a branch kept by an archive stays untrusted
// when a new workspace uses it.
const forkKey = (branch: string) => `branch.${branch}.octopusFromFork`;

export const markForkBranch = Effect.fn("markForkBranch")(function* (repositoryPath: string, branch: string) {
	yield* runGit(repositoryPath, ["config", "--type=bool", forkKey(branch), "true"]);
});

// Whether a folder's checked-out branch holds a fork's code: Octopus marked it, or it pulls from a URL rather
// than a configured remote, as `gh pr checkout` sets up for a fork's pull request. A branch tracking a named
// remote such as upstream is the user's own. A detached HEAD shows neither.
export const isForkCheckout = Effect.fn("isForkCheckout")(function* (path: string) {
	const branch = yield* runGit(path, ["branch", "--show-current"]);
	if (branch === "") return false;
	if (yield* isForkBranch(path, branch)) return true;
	const remote = yield* runGit(path, ["config", "--default", "", "--get", `branch.${branch}.remote`]);
	if (remote === "" || remote === ".") return false;
	const remotes = yield* runGit(path, ["remote"]);
	return !remotes.split("\n").includes(remote);
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
