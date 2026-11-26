import { errorMessage, type Follow } from "./daemonRuntime.ts";
import type { TerminalOutput } from "@repo/contracts/Terminal";
import { followReattaching } from "./followReattaching.ts";
import { isConnectionDrop } from "./errorMessage.ts";

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

// Keystrokes typed while the connection is down cannot reach the shell. Replaying them later could run a half-typed
// command, so they are dropped, and the screen says so once per outage.
export const terminalInput = (screen: TerminalScreen) => {
	let noted = false;
	return {
		failed: (error: unknown) => {
			if (noted || !isConnectionDrop(error)) return;
			noted = true;
			screen.write(note("Not sent: the connection to the daemon dropped. Type it again once it reconnects"));
		},
		sent: () => {
			noted = false;
		},
	};
};
