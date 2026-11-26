import { TerminalNotFoundError, type TerminalOutput } from "@repo/contracts/Terminal";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { followTerminal, terminalInput } from "./followTerminal.ts";
import type { Follow } from "./daemonRuntime.ts";

// A fake daemon: each attach is recorded, and the test drives its stream.
const fakeDaemon = () => {
	const attaches: Array<Follow<TerminalOutput>> = [];
	let stops = 0;
	const attach = (follow: Follow<TerminalOutput>) => {
		attaches.push(follow);
		return () => {
			stops++;
		};
	};
	return { attach, attaches, stops: () => stops };
};

const fakeScreen = () => {
	let text = "";
	return {
		screen: {
			reset: () => {
				text = "";
			},
			write: (data: string) => {
				text += data;
			},
		},
		text: () => text,
	};
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("followTerminal", () => {
	test("reattaches after the connection drops and shows the scrollback once", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onItem({ type: "data", data: "$ ls\r\n" });
		daemon.attaches[0]?.onEnd?.({ _tag: "RpcClientError", message: "SocketCloseError: closed" });
		expect(view.text()).toContain("Disconnected. Reconnecting");

		jest.advanceTimersByTime(1000);
		expect(daemon.attaches).toHaveLength(2);
		// The daemon replays everything it kept as the first data event of the new attach.
		daemon.attaches[1]?.onItem({ type: "data", data: "$ ls\r\nREADME.md\r\n" });
		expect(view.text()).toBe("$ ls\r\nREADME.md\r\n");
	});

	test("says it is reconnecting once per outage, not on every retry", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		followTerminal(daemon.attach, view.screen);
		const drop = { _tag: "RpcClientError", message: "SocketCloseError: closed" };
		daemon.attaches[0]?.onEnd?.(drop);
		jest.advanceTimersByTime(1000);
		daemon.attaches[1]?.onEnd?.(drop);
		jest.advanceTimersByTime(1000);
		expect(view.text().match(/Reconnecting/g)).toHaveLength(1);
		daemon.attaches[2]?.onItem({ type: "data", data: "$ " });
		daemon.attaches[2]?.onEnd?.(drop);
		expect(view.text().match(/Reconnecting/g)).toHaveLength(1);
		expect(view.text()).toBe("$ \r\n\x1b[2m[Disconnected. Reconnecting]\x1b[0m\r\n");
	});

	test("says the shell exited and does not reattach", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onItem({ type: "exit", exitCode: 0 });
		daemon.attaches[0]?.onEnd?.(null);
		jest.advanceTimersByTime(5000);
		expect(view.text()).toContain("The shell exited with code 0");
		expect(view.text()).not.toContain("Reconnecting");
		expect(daemon.attaches).toHaveLength(1);
	});

	test("stops trying when the daemon no longer has the terminal", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onEnd?.(new TerminalNotFoundError({ terminalId: "t1" }));
		jest.advanceTimersByTime(5000);
		expect(view.text()).toContain("This terminal has closed");
		expect(daemon.attaches).toHaveLength(1);
	});

	test("a stopped terminal does not reattach", () => {
		const daemon = fakeDaemon();
		const view = fakeScreen();
		const stop = followTerminal(daemon.attach, view.screen);
		daemon.attaches[0]?.onEnd?.({ _tag: "RpcClientError", message: "SocketCloseError: closed" });
		stop();
		jest.advanceTimersByTime(5000);
		expect(daemon.attaches).toHaveLength(1);
		expect(daemon.stops()).toBe(1);
	});
});

describe("terminalInput", () => {
	const drop = { _tag: "RpcClientError", message: "SocketCloseError: closed" };

	test("says once per outage that keystrokes did not reach the shell", () => {
		const view = fakeScreen();
		const input = terminalInput(view.screen);
		input.failed(drop);
		input.failed(drop);
		expect(view.text().match(/Not sent/g)).toHaveLength(1);
		input.sent();
		input.failed(drop);
		expect(view.text().match(/Not sent/g)).toHaveLength(2);
	});

	test("stays quiet when the shell has exited, which the attach stream reports", () => {
		const view = fakeScreen();
		terminalInput(view.screen).failed(new TerminalNotFoundError({ terminalId: "t1" }));
		expect(view.text()).toBe("");
	});
});
