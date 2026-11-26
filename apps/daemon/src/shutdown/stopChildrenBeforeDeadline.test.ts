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

	test("a stop under way still finishes, SIGKILLs included, when the layers close", async () => {
		const finished = await Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			let done = false;
			const layer = StopChildrenBeforeDeadline.pipe(
				Layer.provide([
					Layer.succeed(Shutdown, Shutdown.of({ request: () => Effect.void, requested: Effect.succeed("rpc") })),
					Layer.succeed(
						ProcessRegistry,
						ProcessRegistry.of({
							add: () => Effect.void,
							remove: () => Effect.void,
							stopAll: Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Effect.sleep(Duration.millis(300))),
								Effect.andThen(
									Effect.sync(() => {
										done = true;
									}),
								),
							),
						}),
					),
					Layer.succeed(ShutdownSettings, { deadline: Duration.sum(STOP_GRACE, STOP_CHILDREN_MARGIN) }),
				]),
			);
			yield* Effect.scoped(Layer.build(layer).pipe(Effect.andThen(Deferred.await(started))));
			return done;
		}).pipe(Effect.runPromise);
		expect(finished).toBe(true);
	});
});
