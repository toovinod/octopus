import type { TerminalOutput } from "@repo/contracts/Terminal";
import { errorTag, type Follow } from "./daemonRuntime.ts";
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
		onDrop: (error) => {
			// The shell exited while we were away, or the daemon restarted without it.
			if (errorTag(error) === "TerminalNotFoundError") {
				screen.write(note("This terminal has closed. Open a new one."));
				return false;
			}
			screen.write(note("Disconnected. Reconnecting"));
			return true;
		},
		onReattach: () => {
			replayed = false;
		},
	});
};
