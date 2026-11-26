import { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import { STOP_GRACE } from "../processes/stopProcessGroup.ts";
import { Shutdown, ShutdownSettings } from "./Shutdown.ts";
import { Duration, Effect, Layer } from "effect";

// Time left after the stop grace for the SIGKILLs to land and the database to close.
export const STOP_CHILDREN_MARGIN = Duration.seconds(1);

// The layers close one after another and each gives its own children the stop grace, so with a few slow
// children the deadline could exit the daemon before the last of them got SIGKILL, leaving them running.
// Late enough that the layers stop most children in order first, every child still recorded gets its stop
// signal at once and its SIGKILL within the deadline. Children kept through shutdown, the archive's git commands,
// are left to finish.
export const StopChildrenBeforeDeadline = Layer.effectDiscard(
	Effect.gen(function* () {
		const shutdown = yield* Shutdown;
		const registry = yield* ProcessRegistry;
		const { deadline } = yield* ShutdownSettings;
		const wait = Duration.max(
			Duration.zero,
			Duration.subtract(deadline, Duration.sum(STOP_GRACE, STOP_CHILDREN_MARGIN)),
		);
		yield* shutdown.requested.pipe(
			Effect.andThen(Effect.sleep(wait)),
			Effect.andThen(Effect.logWarning("Shutdown is taking long, stopping every child that is left")),
			Effect.andThen(registry.stopAll),
			Effect.forkScoped,
		);
	}),
);
