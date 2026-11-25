import { Clock, Effect, Random } from "effect";

// Unique to one agent process. Agents number their own requests from scratch each time they start, so ids
// built on it never repeat within a chat across restarts.
export const makeProcessId = Effect.map(
	Effect.all([Clock.currentTimeMillis, Random.nextIntBetween(0, 2 ** 31)]),
	([now, random]) => `${now.toString(36)}${random.toString(36)}`,
);
