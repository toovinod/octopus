import { GitTimeoutSettings, gitTimeoutSettingsFromConfig } from "./GitTimeoutSettings.ts";
import { ConfigProvider, Duration, Effect, Layer } from "effect";
import { describe, expect, test } from "bun:test";

const readWith = (env: Record<string, string>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const settings = yield* GitTimeoutSettings;
			return { local: Duration.toMinutes(settings.local), network: Duration.toMinutes(settings.network) };
		}).pipe(
			Effect.provide(
				gitTimeoutSettingsFromConfig.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))),
			),
		),
	);

describe("gitTimeoutSettingsFromConfig", () => {
	test("keeps the defaults when nothing is set", async () => {
		expect(await readWith({})).toEqual({ local: 2, network: 5 });
	});

	test("reads longer limits from the environment", async () => {
		expect(await readWith({ OCTOPUS_GIT_TIMEOUT: "10 minutes", OCTOPUS_GIT_NETWORK_TIMEOUT: "30 minutes" })).toEqual({
			local: 10,
			network: 30,
		});
	});

	test("fails on a value that is not a duration", async () => {
		await expect(readWith({ OCTOPUS_GIT_NETWORK_TIMEOUT: "soon" })).rejects.toThrow();
	});
});
