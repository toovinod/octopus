import { isGoneWithin, WITH_GRANDCHILD } from "../testing/processTesting.ts";
import { TrackedChildProcessSpawner } from "./TrackedChildProcessSpawner.ts";
import { KeepThroughShutdown, ProcessRegistry } from "./ProcessRegistry.ts";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";

describe("TrackedChildProcessSpawner", () => {
	test("records a child until it exits and stops its grandchildren with it", async () => {
		const events: Array<string> = [];
		const recordingRegistry = Layer.succeed(
			ProcessRegistry,
			ProcessRegistry.of({
				add: (pgid) => Effect.sync(() => events.push(`add ${pgid}`)),
				remove: (pgid) => Effect.sync(() => events.push(`remove ${pgid}`)),
				stopAll: Effect.void,
			}),
		);
		const result = await Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const { pid, grandchild } = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", WITH_GRANDCHILD]));
					const line = yield* handle.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
					return { pid: handle.pid, grandchild: Number(Option.getOrThrow(line)) };
				}),
			);
			const grandchildGone = yield* isGoneWithin(grandchild);
			yield* Effect.sync(() => events.length).pipe(
				Effect.repeat({ schedule: Schedule.spaced(Duration.millis(10)), while: (count) => count < 2 }),
				Effect.timeout(Duration.seconds(2)),
			);
			return { events, grandchildGone, pid };
		}).pipe(
			Effect.provide(TrackedChildProcessSpawner.pipe(Layer.provide([recordingRegistry, BunServices.layer]))),
			Effect.runPromise,
		);
		expect(result.grandchildGone).toBe(true);
		expect(result.events).toEqual([`add ${result.pid}`, `remove ${result.pid}`]);
	});

	test("tells the registry which children are kept through shutdown", async () => {
		const added: Array<boolean> = [];
		const recordingRegistry = Layer.succeed(
			ProcessRegistry,
			ProcessRegistry.of({
				add: (_pgid, options) => Effect.sync(() => added.push(options?.keepThroughShutdown ?? false)),
				remove: () => Effect.void,
				stopAll: Effect.void,
			}),
		);
		await Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const run = spawner.string(ChildProcess.make("/bin/sh", ["-c", "true"]));
			yield* run;
			yield* run.pipe(Effect.provideService(KeepThroughShutdown, true));
		}).pipe(
			Effect.provide(TrackedChildProcessSpawner.pipe(Layer.provide([recordingRegistry, BunServices.layer]))),
			Effect.runPromise,
		);
		expect(added).toEqual([false, true]);
	});

	test("keeps a group recorded after its leader exits, while a grandchild still holds it", async () => {
		const events: Array<string> = [];
		const recordingRegistry = Layer.succeed(
			ProcessRegistry,
			ProcessRegistry.of({
				add: (pgid) => Effect.sync(() => events.push(`add ${pgid}`)),
				remove: (pgid) => Effect.sync(() => events.push(`remove ${pgid}`)),
				stopAll: Effect.void,
			}),
		);
		const result = await Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", "sleep 30 & echo $!"]));
			const line = yield* handle.stdout.pipe(Stream.decodeText, Stream.splitLines, Stream.runHead);
			const grandchild = Number(Option.getOrThrow(line));
			yield* Effect.addFinalizer(() => Effect.sync(() => process.kill(grandchild, "SIGKILL")).pipe(Effect.ignore));
			yield* handle.exitCode;
			yield* Effect.sleep(Duration.millis(300));
			return { whileHeld: [...events], pid: handle.pid };
		}).pipe(
			Effect.scoped,
			Effect.provide(TrackedChildProcessSpawner.pipe(Layer.provide([recordingRegistry, BunServices.layer]))),
			Effect.runPromise,
		);
		expect(result.whileHeld).toEqual([`add ${result.pid}`]);
	});
});
