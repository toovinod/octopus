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

// A capped command's stdout passed its cap. Never a GitCommandError, so no handler takes it for git's refusal.
export class GitOutputTooLargeError extends Schema.TaggedError<GitOutputTooLargeError>()("GitOutputTooLargeError", {
	args: Schema.Array(Schema.String),
	maxLength: Schema.Int,
}) {}

// Past this, stderr keeps its start, which says what went wrong.
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

// Leading whitespace is kept because `git status --porcelain` lines start with a space. With `maxLength`, stdout
// past it fails the command, since a patch cut short would read as a whole one.
const gitCommand = Effect.fnUntraced(
	function* (
		cwd: string,
		args: ReadonlyArray<string>,
		env: Readonly<Record<string, string>> | undefined,
		maxLength: number,
	) {
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
			[collectText(handle.stdout, maxLength), collectText(handle.stderr, STDERR_MAX_LENGTH), handle.exitCode],
			{ concurrency: "unbounded" },
		);
		if (stdout.cut) {
			return yield* new GitOutputTooLargeError({ args: [...args], maxLength });
		}
		if (exitCode !== 0) {
			return yield* new GitCommandError({ args: [...args], exitCode, stderr: stderr.text.trim() });
		}
		return stdout.text.trimEnd();
	},
	Effect.scoped,
	(effect, _cwd, args) =>
		effect.pipe(
			withGitDeadline(`git ${args[0] ?? ""}`, NETWORK_COMMANDS.has(args[0] ?? "") ? "network" : "local"),
			Effect.catchTag("PlatformError", (cause) => Effect.fail(new GitSpawnError({ args: [...args], cause }))),
		),
);

// Uncapped, since a status or a file listing cut short would hide work that a safety check must see.
export const runGit = Effect.fn("runGit")(function* (
	cwd: string,
	args: ReadonlyArray<string>,
	env?: Readonly<Record<string, string>>,
) {
	return yield* gitCommand(cwd, args, env, Number.POSITIVE_INFINITY).pipe(
		// Without a cap nothing is ever cut.
		Effect.catchTag("GitOutputTooLargeError", Effect.die),
	);
});

// For output whose size the repository's content decides, such as a patch.
export const runGitCapped = Effect.fn("runGitCapped")(function* (
	cwd: string,
	args: ReadonlyArray<string>,
	maxLength: number,
) {
	return yield* gitCommand(cwd, args, undefined, maxLength);
});
