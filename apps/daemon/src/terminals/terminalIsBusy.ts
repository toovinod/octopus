import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Effect } from "effect";

// Whether a terminal's shell is running a command, such as a dev server or a build, rather than waiting at its
// prompt. The shell hands the PTY's foreground to each command it runs, and takes it back at the prompt.
// Children do not tell: prompt helpers such as gitstatusd stay running in the background of an idle shell.
export const terminalIsBusy = Effect.fn("terminalIsBusy")(function* (shellPid: number) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const output = yield* spawner.string(ChildProcess.make("ps", ["-o", "pgid=,tpgid=", "-p", String(shellPid)]));
	const [group, foreground] = output.trim().split(/\s+/).map(Number);
	// Without a controlling terminal, as on Linux, ps prints a foreground group of 0 or -1: nothing to tell by.
	return foreground !== undefined && foreground > 0 && foreground !== group;
});
