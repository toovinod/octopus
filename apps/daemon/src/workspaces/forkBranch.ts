import { runGit } from "../git/runGit.ts";
import { Effect } from "effect";

// A branch holding a fork's code keeps that mark in the repository's own git config, which code in a
// pull request cannot write. It outlives the workspace, so a branch kept by an archive stays untrusted
// when a new workspace uses it.
const forkKey = (branch: string) => `branch.${branch}.octopusFromFork`;

export const markForkBranch = Effect.fn("markForkBranch")(function* (repositoryPath: string, branch: string) {
	yield* runGit(repositoryPath, ["config", "--type=bool", forkKey(branch), "true"]);
});

// Whether a folder's checked-out branch holds a fork's code: Octopus marked it, or it is set up the way
// `gh pr checkout` sets up a fork's pull request, pulling from a URL or from a remote the user added for the fork,
// or pulling the pull request's head (refs/pull/<n>/head) when the fork keeps maintainers out. git config cannot
// tell a fork's remote from the project's own by its name, so only origin and the remote gh uses as the base
// repository count as the project's: a branch on any other remote counts as a fork's. A detached HEAD shows neither.
// It reads the whole config in one call and filters it here, so a branch name needs no regex escaping and a
// workspace listing spends two git calls per workspace rather than five.
export const isForkCheckout = Effect.fn("isForkCheckout")(function* (path: string) {
	const branch = yield* runGit(path, ["branch", "--show-current"]);
	if (branch === "") return false;
	const config = parseConfigList(yield* runGit(path, ["config", "--null", "--list"]));
	// Git lowercases a key's section and name in the listing, but keeps the branch name's case.
	const mark = readForkMark(config.get(`branch.${branch}.octopusfromfork`));
	if (mark === "unknown" ? yield* isForkBranch(path, branch) : mark) return true;
	const remote = config.get(`branch.${branch}.remote`) ?? "";
	if (remote === "" || remote === ".") return false;
	const merge = config.get(`branch.${branch}.merge`) ?? "";
	if (merge.startsWith("refs/pull/")) return true;
	if (remote === "origin") return false;
	// What `gh repo set-default`, or gh's own question in a repository with several remotes, records. Git keeps
	// the remote name's case in the listing.
	return config.get(`remote.${remote}.gh-resolved`) !== "base";
});

// Splits `git config --null --list` output into key and value. A key set without a value (`[branch "x"] remote`)
// lists as null. The last value of a key wins, as `git config --get` returns it.
const parseConfigList = (output: string) =>
	new Map(
		output
			.split("\0")
			.filter((entry) => entry !== "")
			.map((entry) => {
				const newline = entry.indexOf("\n");
				return newline === -1 ? [entry, null] : [entry.slice(0, newline), entry.slice(newline + 1)];
			}),
	);

// Git's own boolean words and the bare key. Anything else (an integer such as 2, or a value git rejects) is left to
// `git config --type=bool`, so the mark keeps exactly git's reading.
const readForkMark = (value: string | null | undefined) => {
	if (value === undefined) return false;
	if (value === null) return true;
	const word = value.toLowerCase();
	if (["true", "yes", "on", "1"].includes(word)) return true;
	if (["false", "no", "off", "0", ""].includes(word)) return false;
	return "unknown";
};

const countAsFork = (path: string) => (cause: unknown) =>
	Effect.logWarning("Could not tell whether the branch is a fork's, so it counts as one", cause).pipe(
		Effect.annotateLogs({ path }),
		Effect.as(true),
	);

// Whether a workspace holds a fork's code: stored when it was made, or seen now on its checked-out branch, as
// after `gh pr checkout` in an in-place workspace. When git cannot tell, it counts as a fork's, so a fork's code
// never gets the project's trust or hooks by accident.
export const holdsForkCode = Effect.fn("holdsForkCode")(function* (workspace: {
	readonly fromFork: boolean;
	readonly path: string;
}) {
	if (workspace.fromFork) return true;
	const giveUp = countAsFork(workspace.path);
	return yield* isForkCheckout(workspace.path).pipe(
		Effect.catchTags({ GitCommandError: giveUp, GitSpawnError: giveUp, GitTimeoutError: giveUp }),
	);
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
