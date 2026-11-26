import { isGoneWithin, WITH_GRANDCHILD } from "../testing/processTesting.ts";
import { testProcessRegistry } from "../testing/testProcessRegistry.ts";
import { Deferred, Duration, Effect } from "effect";
import { spawnTerminal } from "./spawnTerminal.ts";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

describe("spawnTerminal", () => {
	test("closing the terminal stops the shell's children too", async () => {
		const gone = await Effect.gen(function* () {
			const firstLine = yield* Deferred.make<string>();
			const grandchild = yield* Effect.scoped(
				Effect.gen(function* () {
					const decoder = new TextDecoder();
					yield* spawnTerminal({
						command: ["/bin/sh", "-c", WITH_GRANDCHILD],
						cwd: tmpdir(),
						cols: 80,
						rows: 24,
						onData: (data) => Deferred.doneUnsafe(firstLine, Effect.succeed(decoder.decode(data))),
					});
					const output = yield* Deferred.await(firstLine).pipe(Effect.timeout(Duration.seconds(3)));
					return Number(output.trim().split(/\s+/)[0]);
				}),
			);
			return yield* isGoneWithin(grandchild);
		}).pipe(Effect.provide(testProcessRegistry), Effect.runPromise);
		expect(gone).toBe(true);
	});

	// zsh never takes the PTY as its controlling terminal when Bun starts it directly, which leaves it without
	// job control and leaves nothing to say whether a command runs in the foreground.
	test.skipIf(!existsSync("/bin/zsh"))("the PTY is the controlling terminal even of zsh", async () => {
		const tty = await Effect.gen(function* () {
			const printed = yield* Deferred.make<string>();
			return yield* Effect.scoped(
				Effect.gen(function* () {
					const decoder = new TextDecoder();
					let output = "";
					yield* spawnTerminal({
						command: ["/bin/zsh", "-f", "-c", "echo tty=$(ps -o tty= -p $$)"],
						cwd: tmpdir(),
						cols: 80,
						rows: 24,
						onData: (data) => {
							output += decoder.decode(data);
							if (output.includes("\n")) Deferred.doneUnsafe(printed, Effect.succeed(output));
						},
					});
					return yield* Deferred.await(printed).pipe(Effect.timeout(Duration.seconds(3)));
				}),
			);
		}).pipe(Effect.provide(testProcessRegistry), Effect.runPromise);
		// ps prints ?? on macOS, or ? on Linux, for a process without a controlling terminal.
		expect(tty).toMatch(/tty=[^?\s]/);
	});
});
