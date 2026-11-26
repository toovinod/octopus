import { Clock, Context, Duration, Effect, FileSystem, Layer, Queue, Schema, Semaphore } from "effect";
import { processExists, signalProcessGroup, stopProcessGroup } from "./stopProcessGroup.ts";
import { PRIVATE_FILE_MODE } from "../database/LocalDatabase.ts";
import { lockDataDirectory } from "./lockDataDirectory.ts";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { wasStartedAt } from "./processStartTime.ts";
import { join } from "node:path";

export const REGISTRY_FILE_NAME = "children.json";

// Most children are short git, gh and lsof calls, so rather than rewrite the file twice for each of them, every
// change in this window goes into one write, and a child gone by then costs none. A child of any kind is in the
// file within this long of starting, so a crash can orphan nothing older.
export const WRITE_SPACING = Duration.millis(100);

// Set around a command that must not be cut short at shutdown, such as the archive's git commands, which can
// leave a worktree half cleaned. Such a child is still recorded, so a crash leaves it for the next start.
export const KeepThroughShutdown = Context.Reference<boolean>("octopus/daemon/processes/KeepThroughShutdown", {
	defaultValue: () => false,
});

export const RegistryEntries = Schema.Array(Schema.Struct({ pgid: Schema.Int, startedAt: Schema.Number }));
const RegistryFile = Schema.fromJsonString(RegistryEntries);

// A process group left by a daemon that died without cleaning up. Its leader is ours when it
// started when we recorded it. A gone leader is safe too: a process group id cannot be reused
// while any member of the group is alive, so signalling -pgid only reaches our leftovers.
const reapEntry = Effect.fn("reapEntry")(function* (entry: { readonly pgid: number; readonly startedAt: number }) {
	if (yield* processExists(entry.pgid)) {
		if (!(yield* wasStartedAt(entry.pgid, entry.startedAt))) {
			return yield* Effect.logWarning("A recorded child's pid now belongs to another process, leaving it alone").pipe(
				Effect.annotateLogs({ pgid: entry.pgid }),
			);
		}
	}
	yield* Effect.logWarning("Stopping a child left by a previous daemon").pipe(
		Effect.annotateLogs({ pgid: entry.pgid }),
	);
	yield* stopProcessGroup(entry.pgid);
});

// Records every child process group in a private file in the data directory, so a daemon that
// starts after a crash can stop what the crashed one left running.
export class ProcessRegistry extends Context.Service<
	ProcessRegistry,
	{
		readonly add: (pgid: number, options?: { readonly keepThroughShutdown?: boolean }) => Effect.Effect<void>;
		readonly remove: (pgid: number) => Effect.Effect<void>;
		// SIGTERMs every recorded group at once, except those kept through shutdown, and SIGKILLs those still
		// alive after the stop grace.
		readonly stopAll: Effect.Effect<void>;
	}
>()("octopus/daemon/processes/ProcessRegistry") {
	static readonly layer = Layer.effect(
		ProcessRegistry,
		Effect.gen(function* () {
			const { dataDir } = yield* DaemonConfig;
			const fs = yield* FileSystem.FileSystem;
			const file = join(dataDir, REGISTRY_FILE_NAME);
			// Before reaping: only with the lock held is a recorded child known to be a crashed daemon's.
			yield* lockDataDirectory(dataDir);

			if (yield* fs.exists(file)) {
				const entries = yield* fs.readFileString(file).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(RegistryFile)),
					Effect.catch((cause) =>
						Effect.logWarning("Could not read the child process registry, so nothing was reaped", cause).pipe(
							Effect.as([]),
						),
					),
				);
				yield* Effect.forEach(entries, reapEntry, { concurrency: "unbounded", discard: true });
			}

			// Every live group with when it started.
			const groups = new Map<number, { readonly startedAt: number; readonly keepThroughShutdown: boolean }>();
			const lock = yield* Semaphore.make(1);
			let written: string | null = null;
			// Written to a temporary file and renamed, so a crash never leaves half a file.
			const save = Effect.gen(function* () {
				const entries = [...groups].map(([pgid, { startedAt }]) => ({ pgid, startedAt }));
				const encoded = yield* Schema.encodeEffect(RegistryFile)(entries);
				if (encoded === written) return;
				yield* fs.writeFileString(`${file}.tmp`, encoded, { mode: PRIVATE_FILE_MODE });
				yield* fs.rename(`${file}.tmp`, file);
				written = encoded;
			}).pipe(
				Effect.catch((cause) => Effect.logWarning("Could not write the child process registry", cause)),
				lock.withPermits(1),
			);
			yield* save;
			// Runs after every layer that spawns has closed, and after the writer below stops. A removal can still
			// be pending for a child that exited a moment ago, and a clean shutdown should leave nothing for the next
			// start. A child still alive goes into the file for the next start to reap.
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					for (const pgid of [...groups.keys()]) {
						if (!(yield* signalProcessGroup(pgid, 0))) groups.delete(pgid);
					}
					yield* save;
				}),
			);
			// The writer: each change wakes it at once, and changes until it is free again share the next write.
			const changed = yield* Queue.sliding<void>(1);
			yield* Queue.take(changed).pipe(
				Effect.andThen(save),
				Effect.andThen(Effect.sleep(WRITE_SPACING)),
				Effect.forever,
				Effect.forkScoped,
			);
			const markChanged = Queue.offer(changed, undefined).pipe(Effect.asVoid);

			return ProcessRegistry.of({
				add: (pgid, options) =>
					Effect.gen(function* () {
						groups.set(pgid, {
							startedAt: yield* Clock.currentTimeMillis,
							keepThroughShutdown: options?.keepThroughShutdown ?? false,
						});
						yield* markChanged;
					}),
				remove: (pgid) =>
					Effect.suspend(() => {
						groups.delete(pgid);
						return markChanged;
					}),
				stopAll: Effect.suspend(() =>
					Effect.forEach(
						[...groups].filter(([, group]) => !group.keepThroughShutdown).map(([pgid]) => pgid),
						(pgid) => stopProcessGroup(pgid),
						{
							concurrency: "unbounded",
							discard: true,
						},
					),
				),
			});
		}),
	);
}
