import { Clock, Context, Duration, Effect, FiberMap, FileSystem, Layer, Schema, Semaphore } from "effect";
import { processExists, signalProcessGroup, stopProcessGroup } from "./stopProcessGroup.ts";
import { PRIVATE_FILE_MODE } from "../database/LocalDatabase.ts";
import { lockDataDirectory } from "./lockDataDirectory.ts";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { wasStartedAt } from "./processStartTime.ts";
import { join } from "node:path";

export const REGISTRY_FILE_NAME = "children.json";

// Most children are short git, gh and lsof calls, so a child goes into the file only once it has run this long,
// rather than the file being rewritten twice for each of them. One younger than this when the daemon crashes is
// not reaped, which leaves at most a command a moment from finishing.
export const RECORD_AFTER = Duration.seconds(1);

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

			// Every live group with when it started, and whether it is in the file yet.
			const groups = new Map<
				number,
				{ readonly startedAt: number; readonly keepThroughShutdown: boolean; recorded: boolean }
			>();
			// The wait before each young group goes into the file.
			const pending = yield* FiberMap.make<number>();
			const lock = yield* Semaphore.make(1);
			// Written to a temporary file and renamed, so a crash never leaves half a file.
			const save = Effect.gen(function* () {
				const entries = [...groups]
					.filter(([, group]) => group.recorded)
					.map(([pgid, { startedAt }]) => ({ pgid, startedAt }));
				const encoded = yield* Schema.encodeEffect(RegistryFile)(entries);
				yield* fs.writeFileString(`${file}.tmp`, encoded, { mode: PRIVATE_FILE_MODE });
				yield* fs.rename(`${file}.tmp`, file);
			}).pipe(
				Effect.catch((cause) => Effect.logWarning("Could not write the child process registry", cause)),
				lock.withPermits(1),
			);
			yield* save;
			// Runs after every layer that spawns has closed. A removal can still be pending for a child
			// that exited a moment ago, and a clean shutdown should leave nothing for the next start. A child
			// still alive, however young, goes into the file for the next start to reap.
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					for (const [pgid, group] of [...groups]) {
						if (yield* signalProcessGroup(pgid, 0)) group.recorded = true;
						else groups.delete(pgid);
					}
					yield* save;
				}),
			);

			return ProcessRegistry.of({
				add: (pgid, options) =>
					Effect.gen(function* () {
						const group = {
							startedAt: yield* Clock.currentTimeMillis,
							keepThroughShutdown: options?.keepThroughShutdown ?? false,
							recorded: false,
						};
						groups.set(pgid, group);
						yield* FiberMap.run(
							pending,
							pgid,
							Effect.sleep(RECORD_AFTER).pipe(
								Effect.andThen(
									Effect.suspend(() => {
										group.recorded = true;
										return save;
									}),
								),
							),
						);
					}),
				remove: (pgid) =>
					Effect.gen(function* () {
						yield* FiberMap.remove(pending, pgid);
						const group = groups.get(pgid);
						groups.delete(pgid);
						if (group?.recorded) yield* save;
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
