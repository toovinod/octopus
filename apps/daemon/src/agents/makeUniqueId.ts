import { Clock, Effect, Random } from "effect";

// Time plus randomness, unique enough for ids that only need to differ from earlier ones, like an agent process's
// (agents number their requests from scratch each time they start) or a turn the agent never named.
export const makeUniqueId = Effect.map(
	Effect.all([Clock.currentTimeMillis, Random.nextIntBetween(0, 2 ** 31)]),
	([now, random]) => `${now.toString(36)}${random.toString(36)}`,
);
