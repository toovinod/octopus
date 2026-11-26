import { signalProcessGroup, STOP_GRACE } from "./stopProcessGroup.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Duration, Effect, Layer, Schedule } from "effect";
import { ProcessRegistry } from "./ProcessRegistry.ts";

// Effect already spawns each command in its own process group and SIGTERMs the group when the
// scope closes. Without forceKillAfter it would wait forever for a child that ignores SIGTERM.
const withStopGrace = (command: ChildProcess.Command): ChildProcess.Command =>
	ChildProcess.isStandardCommand(command) && command.options.forceKillAfter === undefined
		? ChildProcess.make(command.command, command.args, { ...command.options, forceKillAfter: STOP_GRACE })
		: command;

// How often a group whose leader exited is checked for members left behind.
const GROUP_POLL = Duration.millis(500);

// Replaces the platform spawner for everything the daemon starts: every child gets the stop
// grace and is recorded in the ProcessRegistry until it exits.
export const TrackedChildProcessSpawner = Layer.effect(
	ChildProcessSpawner.ChildProcessSpawner,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const registry = yield* ProcessRegistry;
		return ChildProcessSpawner.make((command) =>
			Effect.gen(function* () {
				const handle = yield* spawner.spawn(withStopGrace(command));
				yield* registry.add(handle.pid);
				// Removed only once nothing is left in the group, not when its scope starts closing or its leader
				// exits: a crash during the stop grace, or while a child the leader left behind runs on, still
				// leaves it in the registry.
				yield* handle.exitCode.pipe(
					Effect.ignore,
					Effect.andThen(
						signalProcessGroup(handle.pid, 0).pipe(
							Effect.repeat({ schedule: Schedule.spaced(GROUP_POLL), while: (alive) => alive }),
						),
					),
					Effect.andThen(registry.remove(handle.pid)),
					Effect.forkDetach,
				);
				return handle;
			}),
		);
	}),
);
