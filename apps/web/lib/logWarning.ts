import { Effect } from "effect";

// For fallbacks in the UI that must still leave a trace. Runs outside the daemon runtime, so it logs even when the
// daemon cannot be reached.
export const logWarning = (message: string, cause: unknown) => {
	Effect.runFork(Effect.logWarning(message, cause));
};
