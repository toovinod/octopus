import { bootErrorMessage, errorMessage } from "./errorMessage.ts";
import { describe, expect, test } from "bun:test";

const generic = "Something went wrong. Try again.";

describe("errorMessage", () => {
	test("shows the message of a daemon error", () => {
		expect(errorMessage({ _tag: "SessionBusyError", message: "The agent is busy. Try again." })).toBe(
			"The agent is busy. Try again.",
		);
	});

	test("says a dropped connection is why, without the socket's own text", () => {
		expect(errorMessage({ _tag: "RpcClientError", message: "SocketCloseError: closed" })).toBe(
			"Octopus lost the connection to its daemon. Try again once it reconnects.",
		);
	});

	test("hides decoding and untagged messages", () => {
		expect(errorMessage({ _tag: "SchemaError", message: "Expected string, got null" })).toBe(generic);
		expect(errorMessage(new Error("TypeError: undefined is not a function"))).toBe(generic);
		expect(errorMessage({ _tag: "DaemonInternalError", message: "" })).toBe(generic);
	});
});

describe("bootErrorMessage", () => {
	// Nothing reconnects on the screen a failed start shows: the user retries there.
	test("says the daemon could not be reached at all when the first connection fails", () => {
		expect(bootErrorMessage({ _tag: "RpcClientError", message: "SocketCloseError: closed" })).toBe(
			"Octopus could not connect to its daemon. Retry, or quit Octopus and open it again.",
		);
	});

	test("shows any other failure as usual", () => {
		expect(bootErrorMessage({ _tag: "SessionBusyError", message: "The agent is busy. Try again." })).toBe(
			"The agent is busy. Try again.",
		);
	});
});
