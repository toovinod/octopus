import { Config, Context, Duration, Effect, Layer } from "effect";
import { GitTimeoutError } from "@repo/contracts/Git";

const DEFAULT_LOCAL = Duration.minutes(2);
const DEFAULT_NETWORK = Duration.minutes(5);

export const GitTimeoutSettings = Context.Reference<{
	// How long a git or gh command may run before it is killed. A hung command (a credential
	// helper waiting for input, a stalled network) would otherwise hold its request forever.
	readonly local: Duration.Duration;
	// For commands that talk to a remote. Every gh command does.
	readonly network: Duration.Duration;
}>("octopus/daemon/git/GitTimeoutSettings", {
	defaultValue: () => ({ local: DEFAULT_LOCAL, network: DEFAULT_NETWORK }),
});

// A huge repository or a slow network can need longer, for example OCTOPUS_GIT_NETWORK_TIMEOUT="15 minutes".
export const gitTimeoutSettingsFromConfig = Layer.effect(
	GitTimeoutSettings,
	Effect.gen(function* () {
		const local = yield* Config.Duration("OCTOPUS_GIT_TIMEOUT").pipe(Config.withDefault(DEFAULT_LOCAL));
		const network = yield* Config.Duration("OCTOPUS_GIT_NETWORK_TIMEOUT").pipe(Config.withDefault(DEFAULT_NETWORK));
		return { local, network };
	}),
);

// Wraps a scoped command, so the timeout closes its scope and the spawner kills the process group.
export const withGitDeadline =
	(command: string, kind: GitTimeoutError["kind"]) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.flatMap(GitTimeoutSettings, (settings) =>
			effect.pipe(
				Effect.timeoutOrElse({
					duration: settings[kind],
					orElse: () => {
						const error = new GitTimeoutError({ command, kind, timeout: Duration.format(settings[kind]) });
						return Effect.logWarning("Stopped a command that ran past its deadline", error).pipe(
							Effect.andThen(Effect.fail(error)),
						);
					},
				}),
			),
		);
