import { describe, expect, test } from "bun:test";
import { errorMessage } from "./errorMessage.ts";

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
