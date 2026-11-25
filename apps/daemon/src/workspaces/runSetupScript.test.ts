import { setupRetryDelay } from "./runSetupScript.ts";
import { describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";

describe("setupRetryDelay", () => {
	test("doubles with each failed attempt, give or take a fifth", async () => {
		const delays = await Effect.runPromise(
			Effect.forEach([1, 3], (attempts) => setupRetryDelay(Duration.millis(100), attempts)),
		);
		const [first = 0, third = 0] = delays.map(Duration.toMillis);
		expect(first).toBeGreaterThanOrEqual(80);
		expect(first).toBeLessThanOrEqual(120);
		expect(third).toBeGreaterThanOrEqual(320);
		expect(third).toBeLessThanOrEqual(480);
	});
});
