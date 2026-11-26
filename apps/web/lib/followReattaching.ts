import { isConnectionDrop } from "./errorMessage.ts";
import type { Follow } from "./daemonRuntime.ts";

const REATTACH_DELAY_MS = 1000;

// Follows a daemon stream across dropped connections: when the connection drops, it attaches to the
// same stream again, and `onDrop` hears about it first. Any other failure would fail the same way on
// every attach, so it ends the follow through `onEnd` like the stream ending does. `onReattach` runs
// before each new attach, so the caller can drop what a replay will repeat, or reload what it missed.
export const followReattaching = <A>(
	follow: (handlers: Follow<A>) => () => void,
	handlers: Follow<A> & {
		readonly onReattach: () => void;
		readonly onDrop?: (error: unknown) => void;
	},
): (() => void) => {
	let stopped = false;
	let stop: () => void = () => undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const attach = () => {
		stop = follow({
			onItem: handlers.onItem,
			onEnd: (error) => {
				if (stopped) return;
				if (error !== null && isConnectionDrop(error)) {
					handlers.onDrop?.(error);
					retry = setTimeout(() => {
						handlers.onReattach();
						attach();
					}, REATTACH_DELAY_MS);
					return;
				}
				handlers.onEnd?.(error);
			},
		});
	};
	attach();
	return () => {
		stopped = true;
		clearTimeout(retry);
		stop();
	};
};
