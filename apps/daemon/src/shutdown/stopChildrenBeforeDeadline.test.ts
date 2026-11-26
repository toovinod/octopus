import { STOP_CHILDREN_MARGIN, StopChildrenBeforeDeadline } from "./stopChildrenBeforeDeadline.ts";
import { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import { STOP_GRACE } from "../processes/stopProcessGroup.ts";
import { Deferred, Duration, Effect, Layer } from "effect";
import { Shutdown, ShutdownSettings } from "./Shutdown.ts";
import { describe, expect, test } from "bun:test";

describe("StopChildrenBeforeDeadline", () => {
	test("once shutdown is requested, stops every child in time for SIGKILL to land before the deadline", async () => {
		const early = Duration.millis(200);
		const stopped = await Effect.gen(function* () {
			const stopAll = yield* Deferred.make<void>();
			const layer = StopChildrenBeforeDeadline.pipe(
				Layer.provide([
					Layer.succeed(Shutdown, Shutdown.of({ request: () => Effect.void, requested: Effect.succeed("rpc") })),
					Layer.succeed(
						ProcessRegistry,
						ProcessRegistry.of({
							add: () => Effect.void,
							remove: () => Effect.void,
							stopAll: Deferred.succeed(stopAll, undefined).pipe(Effect.asVoid),
						}),
					),
					Layer.succeed(ShutdownSettings, {
						deadline: Duration.sum(Duration.sum(STOP_GRACE, STOP_CHILDREN_MARGIN), early),
					}),
				]),
			);
			yield* Layer.build(layer);
			return yield* Deferred.await(stopAll).pipe(Effect.timeoutOption(Duration.seconds(2)));
		}).pipe(Effect.scoped, Effect.runPromise);
		expect(stopped._tag).toBe("Some");
	});
});
