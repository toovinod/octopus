import { Context, type Duration, Effect, Schedule, Stream } from "effect";
import type { PullRequestStatus } from "@repo/contracts/Git";

export const PullRequestPollSettings = Context.Reference<{ readonly interval: Duration.Input }>(
	"octopus/daemon/git/PullRequestPollSettings",
	// Each read is a GitHub API call through gh, so the poll stays well inside its rate limit.
	{ defaultValue: () => ({ interval: "15 seconds" }) },
);

const settled = (status: PullRequestStatus) => status.status === "none" || status.pullRequest.checks.pending === 0;

// Reads the pull request again after each interval and sends every read, until no check is pending.
// The caller already holds the current state, so the first read waits one interval too.
export const pollPullRequestChecks = <E, R>(
	read: Effect.Effect<PullRequestStatus, E, R>,
): Stream.Stream<PullRequestStatus, E, R> =>
	Stream.unwrap(
		Effect.map(PullRequestPollSettings, ({ interval }) =>
			Stream.fromEffectSchedule(Effect.delay(read, interval), Schedule.forever).pipe(Stream.takeUntil(settled)),
		),
	);
