import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { withGitDeadline } from "./GitTimeoutSettings.ts";
import { Effect, Schema, Stream } from "effect";

export class GitSpawnError extends Schema.TaggedError<GitSpawnError>()("GitSpawnError", {
	args: Schema.Array(Schema.String),
	cause: Schema.Defect(),
}) {}

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
	args: Schema.Array(Schema.String),
	exitCode: Schema.Int,
	stderr: Schema.String,
}) {}

// Past these, stderr keeps its start, which says what went wrong, and stdout fails the command, since a listing
// or a patch cut short would read as a whole one. Both are far past what any command the daemon runs prints.
export const STDOUT_MAX_LENGTH = 32 * 1024 * 1024;
export const STDERR_MAX_LENGTH = 64 * 1024;

// A child's output as text, holding at most `maxLength` characters however much it prints.
export const collectText = <E, R>(bytes: Stream.Stream<Uint8Array, E, R>, maxLength: number) =>
	Stream.runFold(
		Stream.decodeText(bytes),
		() => ({ text: "", cut: false }),
		(kept, chunk) => {
			const room = maxLength - kept.text.length;
			return chunk.length <= room
				? { text: kept.text + chunk, cut: kept.cut }
				: { text: kept.text + chunk.slice(0, room), cut: true };
		},
	);

// These reach a remote, so they get the longer deadline.
const NETWORK_COMMANDS = new Set(["push", "fetch", "pull", "clone", "ls-remote"]);

// Leading whitespace is kept because `git status --porcelain` lines start with a space.
export const runGit = Effect.fn("runGit")(
	function* (cwd: string, args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		// Git must never wait for a password on a terminal nobody sees.
		const handle = yield* spawner.spawn(
			ChildProcess.make("git", args, {
				cwd,
				// Extra variables, such as GIT_INDEX_FILE for a temporary index.
				env: { ...env, GIT_TERMINAL_PROMPT: "0" },
				extendEnv: true,
				// After a timeout, a process that ignores SIGTERM must not hold the request either.
				forceKillAfter: "2 seconds",
			}),
		);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collectText(handle.stdout, STDOUT_MAX_LENGTH), collectText(handle.stderr, STDERR_MAX_LENGTH), handle.exitCode],
			{ concurrency: "unbounded" },
		);
		if (exitCode !== 0 || stdout.cut) {
			return yield* new GitCommandError({
				args: [...args],
				exitCode,
				stderr: stdout.cut ? `The output passed ${STDOUT_MAX_LENGTH} characters.` : stderr.text.trim(),
			});
		}
		return stdout.text.trimEnd();
	},
	Effect.scoped,
	(effect, _cwd, args, _env?) =>
		effect.pipe(
			withGitDeadline(`git ${args[0] ?? ""}`, NETWORK_COMMANDS.has(args[0] ?? "") ? "network" : "local"),
			Effect.catchTag("PlatformError", (cause) => Effect.fail(new GitSpawnError({ args: [...args], cause }))),
		),
);
