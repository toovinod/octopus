import type { Follow } from "./daemonRuntime.ts";

const REATTACH_DELAY_MS = 1000;

// Follows a daemon stream across dropped connections: when the connection drops, it attaches to the
// same stream again. `onDrop` sees the failure first and returns false when it is final, which stops
// for good. `onReattach` runs before each new attach, so the caller can drop what a replay will
// repeat, or reload what it missed meanwhile. `onEnd` runs only when the stream itself ends.
export const followReattaching = <A>(
	follow: (handlers: Follow<A>) => () => void,
	handlers: Follow<A> & {
		readonly onReattach: () => void;
		readonly onDrop?: (error: unknown) => boolean;
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
				if (error === null) {
					handlers.onEnd?.(null);
					return;
				}
				if (handlers.onDrop?.(error) === false) return;
				retry = setTimeout(() => {
					handlers.onReattach();
					attach();
				}, REATTACH_DELAY_MS);
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
