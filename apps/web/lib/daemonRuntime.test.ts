import { DaemonConnectionError, errorMessage } from "./daemonRuntime.ts";
import { describe, expect, test } from "bun:test";

describe("DaemonConnectionError", () => {
	test("shows the reason the shell gave for the stopped daemon", () => {
		const error = new DaemonConnectionError({ cause: "Another Octopus is already running." });
		expect(errorMessage(error)).toBe("Another Octopus is already running.");
	});

	test("falls back to a plain message for any other failure", () => {
		expect(errorMessage(new DaemonConnectionError({ cause: new Error("ipc") }))).toBe(
			"Octopus could not reach its daemon.",
		);
	});
});
