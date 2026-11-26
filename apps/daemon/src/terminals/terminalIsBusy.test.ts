import { testProcessRegistry } from "../testing/testProcessRegistry.ts";
import { Deferred, Duration, Effect, Layer } from "effect";
import { terminalIsBusy } from "./terminalIsBusy.ts";
import { BunServices } from "@effect/platform-bun";
import { spawnTerminal } from "./spawnTerminal.ts";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

// Types each line into an interactive shell, waits for the marker it prints, then checks whether it is busy.
const busyAfter = (lines: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		let output = "";
		const marked = yield* Deferred.make<void>();
		const decoder = new TextDecoder();
		const { terminal, pid } = yield* spawnTerminal({
			command: ["/bin/sh", "-i"],
			cwd: tmpdir(),
			cols: 80,
			rows: 24,
			onData: (data) => {
				output += decoder.decode(data);
				// The typed line echoes "mark-$((1+1))"; only the shell's own output reads "mark-2".
				if (output.includes("mark-2")) Deferred.doneUnsafe(marked, Effect.void);
			},
		});
		for (const line of lines) terminal.write(`${line}\n`);
		yield* Deferred.await(marked).pipe(Effect.timeout(Duration.seconds(3)));
		return yield* terminalIsBusy(pid);
	}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(testProcessRegistry, BunServices.layer)), Effect.runPromise);

describe("terminalIsBusy", () => {
	test("a shell waiting at its prompt is not busy", async () => {
		expect(await busyAfter(["echo mark-$((1+1))"])).toBe(false);
	});

	// Prompt helpers such as gitstatusd stay running in the background of an idle shell.
	test("a shell with only background jobs is not busy", async () => {
		expect(await busyAfter(["sleep 30 &", "echo mark-$((1+1))"])).toBe(false);
	});

	test("a shell running a command in the foreground is busy", async () => {
		expect(await busyAfter(["sh -c 'echo mark-$((1+1)); sleep 30'"])).toBe(true);
	});
});
