import { GitHubListError, OpenIssue, OpenPullRequest } from "@repo/contracts/Workspace";
import { type GhCommandError, requireGhLogin, runGh } from "../git/runGh.ts";
import { runGit } from "../git/runGit.ts";
import { Effect, Schema } from "effect";

// Local branches and origin's, without origin/HEAD, each name once.
export const listBranches = Effect.fn("listBranches")(function* (repositoryPath: string) {
	const output = yield* runGit(repositoryPath, [
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads",
		"refs/remotes/origin",
	]);
	const names = output
		.split("\n")
		.map((ref) => ref.replace(/^refs\/heads\/|^refs\/remotes\/origin\//, ""))
		.filter((name) => name !== "" && name !== "HEAD");
	return [...new Set(names)].sort();
});

// GitHub's own page size. More than this many open items is a list nobody scrolls.
const LIMIT = "100";

const GhPullRequests = Schema.fromJsonString(
	Schema.Array(
		Schema.Struct({
			number: Schema.Int,
			title: Schema.String,
			headRefName: Schema.String,
			author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
		}),
	),
);

const GhIssues = Schema.fromJsonString(
	Schema.Array(Schema.Struct({ number: Schema.Int, title: Schema.String, body: Schema.String, url: Schema.String })),
);

const failList =
	(repositoryPath: string, subject: GitHubListError["subject"]) => (cause: GhCommandError | Schema.SchemaError) =>
		requireGhLogin(repositoryPath).pipe(
			Effect.andThen(Effect.logError(`Could not list open ${subject}`, cause)),
			Effect.andThen(Effect.fail(new GitHubListError({ subject }))),
		);

export const listOpenPullRequests = Effect.fn("listOpenPullRequests")(function* (repositoryPath: string) {
	const fail = failList(repositoryPath, "pull requests");
	const output = yield* runGh(repositoryPath, [
		"pr",
		"list",
		"--state",
		"open",
		"--limit",
		LIMIT,
		"--json",
		"number,title,headRefName,author",
	]).pipe(Effect.catchTag("GhCommandError", fail));
	const found = yield* Schema.decodeUnknownEffect(GhPullRequests)(output).pipe(Effect.catchTag("SchemaError", fail));
	return found.map(
		(item) =>
			new OpenPullRequest({
				number: item.number,
				title: item.title,
				branch: item.headRefName,
				author: item.author?.login ?? "ghost",
			}),
	);
});

export const listOpenIssues = Effect.fn("listOpenIssues")(function* (repositoryPath: string) {
	const fail = failList(repositoryPath, "issues");
	const output = yield* runGh(repositoryPath, [
		"issue",
		"list",
		"--state",
		"open",
		"--limit",
		LIMIT,
		"--json",
		"number,title,body,url",
	]).pipe(Effect.catchTag("GhCommandError", fail));
	const found = yield* Schema.decodeUnknownEffect(GhIssues)(output).pipe(Effect.catchTag("SchemaError", fail));
	return found.map((item) => new OpenIssue(item));
});
