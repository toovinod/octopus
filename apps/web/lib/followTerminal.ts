import { errorMessage, type Follow } from "./daemonRuntime.ts";
import type { TerminalOutput } from "@repo/contracts/Terminal";
import { followReattaching } from "./followReattaching.ts";

export interface TerminalScreen {
	readonly reset: () => void;
	readonly write: (data: string) => void;
}

const note = (text: string) => `\r\n\x1b[2m[${text}]\x1b[0m\r\n`;

// Keeps a terminal view attached to its PTY while the PTY runs. A dropped connection reattaches, and because every
// attach starts with the daemon's scrollback, the screen is cleared first so the output shows once.
export const followTerminal = (
	attach: (follow: Follow<TerminalOutput>) => () => void,
	screen: TerminalScreen,
): (() => void) => {
	let replayed = false;
	return followReattaching(attach, {
		onItem: (output) => {
			if (output.type === "exit") {
				screen.write(note(`The shell exited${output.exitCode === null ? "" : ` with code ${output.exitCode}`}`));
				return;
			}
			if (!replayed) {
				replayed = true;
				screen.reset();
			}
			screen.write(output.data);
		},
		onDrop: () => screen.write(note("Disconnected. Reconnecting")),
		// The shell exited while we were away, or the daemon restarted without it, or the attach cannot work.
		onEnd: (error) => {
			if (error !== null) screen.write(note(errorMessage(error)));
		},
		onReattach: () => {
			replayed = false;
		},
	});
};
