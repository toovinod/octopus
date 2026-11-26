import { ConfigProvider, Duration, Effect, FileSystem, Layer, Stream } from "effect";
import { LIVE_CHUNK, TerminalService, splitLiveOutput } from "./TerminalService.ts";
import { testProcessRegistry } from "../testing/testProcessRegistry.ts";
import { SCROLLBACK_MAX_LINES, Scrollback } from "./Scrollback.ts";
import { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import { STOP_GRACE } from "../processes/stopProcessGroup.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { SecureRandom } from "effect/crypto";

const size = { cols: 80, rows: 24 };

const runTerminalTest = <A, E>(program: (tempDir: string) => Effect.Effect<A, E, TerminalService>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const tempDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
		return yield* program(tempDir).pipe(Effect.provide(TerminalService.layer));
	}).pipe(
		Effect.scoped,
		Effect.provide(
			Layer.mergeAll(
				BunServices.layer,
				SecureRandom.layerWebCrypto,
				testProcessRegistry,
				ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SHELL: "/bin/sh" } })),
			),
		),
		Effect.runPromise,
	);

const outputText = (outputs: ReadonlyArray<{ readonly type: string; readonly data?: string }>) =>
	outputs.map((output) => output.data ?? "").join("");

describe("TerminalService", () => {
	test("runs a shell in the workspace folder and streams its output until it exits", async () => {
		const result = await runTerminalTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const info = yield* terminals.open("workspace-1", tempDir, size);
				const listed = terminals.list("workspace-1");
				yield* terminals.write(info.id, "pwd; echo done-$((1 + 1)); exit 7\n");
				const outputs = yield* Stream.runCollect(terminals.attach(info.id));
				return { tempDir, listed, outputs, afterExit: terminals.list("workspace-1") };
			}),
		);
		expect(result.listed).toHaveLength(1);
		expect(outputText(result.outputs)).toContain(result.tempDir);
		expect(outputText(result.outputs)).toContain("done-2");
		expect(result.outputs.at(-1)).toEqual({ type: "exit", exitCode: 7 });
		expect(result.afterExit).toEqual([]);
	});

	test("closing a workspace stops its terminals at once, not one after another", async () => {
		const took = await runTerminalTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				// Shells that ignore SIGHUP, so each needs the whole stop grace and then SIGKILL.
				for (let index = 0; index < 2; index++) {
					const info = yield* terminals.open("workspace-1", tempDir, size);
					yield* terminals.write(info.id, "trap '' HUP; echo trap-$((1 + 1))\n");
					yield* terminals.attach(info.id).pipe(
						Stream.takeUntil((output) => output.type === "data" && output.data.includes("trap-2")),
						Stream.runDrain,
					);
				}
				const [elapsed] = yield* Effect.timed(terminals.closeWorkspace("workspace-1"));
				return Duration.toMillis(elapsed);
			}),
		);
		expect(took).toBeLessThan(Duration.toMillis(STOP_GRACE) * 1.5);
	}, 20_000);

	test("a client that attaches later gets the scrollback first", async () => {
		const text = await runTerminalTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const info = yield* terminals.open("workspace-1", tempDir, size);
				yield* terminals.write(info.id, "echo early-line\n");
				// Wait until the shell printed it, then attach a fresh client.
				yield* terminals.attach(info.id).pipe(
					Stream.takeUntil((output) => output.type === "data" && output.data.includes("early-line\r\n")),
					Stream.runDrain,
				);
				const first = yield* terminals.attach(info.id).pipe(Stream.take(1), Stream.runCollect);
				return outputText(first);
			}),
		);
		expect(text).toContain("early-line");
	});

	test("closing the workspace kills its terminals and only those", async () => {
		const result = await runTerminalTest((tempDir) =>
			Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const first = yield* terminals.open("workspace-1", tempDir, size);
				yield* terminals.open("workspace-1", tempDir, size);
				const other = yield* terminals.open("workspace-2", tempDir, size);
				yield* terminals.resize(first.id, { cols: 120, rows: 40 });
				yield* terminals.closeWorkspace("workspace-1");
				return {
					closed: terminals.list("workspace-1"),
					kept: terminals.list("workspace-2").map((info) => info.id),
					other: other.id,
					writeError: yield* Effect.flip(terminals.write(first.id, "x")),
				};
			}),
		);
		expect(result.closed).toEqual([]);
		expect(result.kept).toEqual([result.other]);
		expect(result.writeError._tag).toBe("TerminalNotFoundError");
	});

	test("keeps output the shell prints while its process group is still being recorded", async () => {
		const text = await Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const tempDir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
			const shell = `${tempDir}/eager.sh`;
			yield* fs.writeFileString(shell, "#!/bin/sh\necho eager-output\nexec /bin/sh\n", { mode: 0o755 });
			// Recording the group writes a file, so a shell can print before it finishes.
			const slowRegistry = Layer.succeed(
				ProcessRegistry,
				ProcessRegistry.of({ add: () => Effect.sleep("300 millis"), remove: () => Effect.void, stopAll: Effect.void }),
			);
			return yield* Effect.gen(function* () {
				const terminals = yield* TerminalService;
				const info = yield* terminals.open("workspace-1", tempDir, size);
				// A shell that prints slowly under load may miss the snapshot, so wait for the text instead.
				const outputs = yield* terminals.attach(info.id).pipe(
					Stream.takeUntil((output) => output.type === "data" && output.data.includes("eager-output")),
					Stream.runCollect,
					Effect.timeout("3 seconds"),
				);
				return outputText(outputs);
			}).pipe(
				Effect.provide(TerminalService.layer),
				Effect.provide(
					Layer.mergeAll(
						slowRegistry,
						SecureRandom.layerWebCrypto,
						ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SHELL: shell } })),
					),
				),
			);
		}).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);
		expect(text).toContain("eager-output");
	});
});

describe("splitLiveOutput", () => {
	test("cuts large output into capped pieces, never inside a surrogate pair", () => {
		const data = `${"a".repeat(LIVE_CHUNK - 1)}😀${"b".repeat(LIVE_CHUNK * 2)}`;
		const pieces = splitLiveOutput(data);
		expect(pieces.join("")).toBe(data);
		expect(pieces.every((piece) => piece.length <= LIVE_CHUNK)).toBe(true);
		expect(pieces[0]).toBe("a".repeat(LIVE_CHUNK - 1));
		expect(splitLiveOutput("small")).toEqual(["small"]);
	});
});

describe("Scrollback", () => {
	test("keeps only the newest lines", () => {
		const scrollback = new Scrollback();
		for (let line = 0; line < SCROLLBACK_MAX_LINES + 100; line++) {
			scrollback.append(`line ${line}\n`);
		}
		const kept = scrollback.toString().split("\n");
		expect(kept[0]).toBe("line 100");
		expect(kept).toHaveLength(SCROLLBACK_MAX_LINES + 1);
	});

	test("trims a single huge chunk to the newest lines", () => {
		const scrollback = new Scrollback();
		scrollback.append(Array.from({ length: SCROLLBACK_MAX_LINES * 2 }, (_, line) => `line ${line}`).join("\n"));
		const kept = scrollback.toString().split("\n");
		expect(kept).toHaveLength(SCROLLBACK_MAX_LINES);
		expect(kept.at(-1)).toBe(`line ${SCROLLBACK_MAX_LINES * 2 - 1}`);
	});
});
