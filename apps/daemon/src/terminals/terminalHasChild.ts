import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect } from "effect";

// Whether a terminal's shell is running something, such as a dev server or a build, rather than waiting at
// its prompt: a shell at its prompt has no children. Best effort: a missing pgrep counts as idle, which is
// logged, so quitting never gets stuck on it.
export const terminalHasChild = Effect.fn("terminalHasChild")(
	function* (shellPid: number) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		// pgrep exits 1 when nothing matches, so only its output says anything.
		const output = yield* spawner.string(ChildProcess.make("pgrep", ["-P", String(shellPid)]));
		return output.trim() !== "";
	},
	Effect.catchTag("PlatformError", (cause) =>
		Effect.logWarning("Could not check whether a terminal is busy", cause).pipe(Effect.as(false)),
	),
);
