import { PullRequestPollSettings, pollPullRequestChecks } from "./pollPullRequestChecks.ts";
import { PullRequest, type PullRequestStatus } from "@repo/contracts/Git";
import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

const found = (pending: number): PullRequestStatus => ({
	status: "found",
	pullRequest: new PullRequest({
		number: 7,
		url: "https://github.com/acme/repo/pull/7",
		title: "Add feature",
		state: "OPEN",
		isDraft: false,
		reviewDecision: null,
		checks: { passing: 1, failing: 0, pending },
	}),
});

// Answers with each status in turn, counting the reads.
const reads = (statuses: ReadonlyArray<PullRequestStatus>) => {
	let count = 0;
	const read = Effect.sync(() => statuses[Math.min(count++, statuses.length - 1)] ?? { status: "none" as const });
	return { read, count: () => count };
};

const collect = (stream: Stream.Stream<PullRequestStatus>) =>
	Stream.runCollect(stream).pipe(
		Effect.provideService(PullRequestPollSettings, { interval: "5 millis" }),
		Effect.timeout("5 seconds"),
		Effect.runPromise,
	);

describe("pollPullRequestChecks", () => {
	test("reads until no check is pending, and sends every read", async () => {
		const source = reads([found(2), found(1), found(0), found(0)]);
		const statuses = await collect(pollPullRequestChecks(source.read));
		expect(statuses.map((status) => (status.status === "found" ? status.pullRequest.checks.pending : null))).toEqual([
			2, 1, 0,
		]);
		expect(source.count()).toBe(3);
	});

	test("stops when the pull request is gone", async () => {
		const source = reads([found(1), { status: "none" }]);
		const statuses = await collect(pollPullRequestChecks(source.read));
		expect(statuses.map((status) => status.status)).toEqual(["found", "none"]);
	});

	test("waits one interval before the first read", async () => {
		const source = reads([found(0)]);
		const program = pollPullRequestChecks(source.read).pipe(
			Stream.runCollect,
			Effect.provideService(PullRequestPollSettings, { interval: "1 hour" }),
			Effect.timeout("50 millis"),
			Effect.flip,
		);
		const error = await Effect.runPromise(program);
		expect(error._tag).toBe("TimeoutError");
		expect(source.count()).toBe(0);
	});
});
