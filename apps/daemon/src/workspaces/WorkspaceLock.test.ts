import { WorkspaceLock } from "./WorkspaceLock.ts";
import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

describe("WorkspaceLock", () => {
	test("a start waits until a rewrite of the workspace's files is done", async () => {
		const steps: Array<string> = [];
		await Effect.gen(function* () {
			const lock = yield* WorkspaceLock;
			const rewrite = yield* lock
				.rewriting(
					"ws-1",
					Effect.sync(() => void steps.push("rewrite begins")).pipe(
						Effect.andThen(Effect.sleep("50 millis")),
						Effect.andThen(Effect.sync(() => void steps.push("rewrite ends"))),
					),
				)
				.pipe(Effect.forkChild);
			yield* Effect.sleep("10 millis");
			yield* lock.starting(
				"ws-1",
				Effect.sync(() => void steps.push("start")),
			);
			yield* Fiber.join(rewrite);
		}).pipe(Effect.provide(WorkspaceLock.layer), Effect.runPromise);
		expect(steps).toEqual(["rewrite begins", "rewrite ends", "start"]);
	});
});
