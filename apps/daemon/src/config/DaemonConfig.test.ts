import { ConfigProvider, Duration, Effect, Option, Redacted, Stdio, Stream } from "effect";
import { DaemonConfig, TAURI_ORIGINS } from "./DaemonConfig.ts";
import { TEST_TOKEN } from "../testing/testDaemonConfig.ts";
import { describe, expect, test } from "bun:test";

const encoder = new TextEncoder();

const stdinOf = (...chunks: ReadonlyArray<string>) => Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk)));

const withStdin = <A, E>(stdin: Stream.Stream<Uint8Array>, program: Effect.Effect<A, E, DaemonConfig>) =>
	program.pipe(
		Effect.provide(DaemonConfig.layer),
		Effect.provide(Stdio.layerTest({ stdin })),
		Effect.result,
		Effect.runPromise,
	);

const configFromStdin = (...chunks: ReadonlyArray<string>) =>
	withStdin(
		stdinOf(...chunks),
		Effect.gen(function* () {
			return yield* DaemonConfig;
		}),
	);

const parentExitedWithin = (stdin: Stream.Stream<Uint8Array>, timeout: Duration.Input) =>
	withStdin(
		stdin,
		Effect.gen(function* () {
			const { parentExited } = yield* DaemonConfig;
			return Option.isSome(yield* Effect.timeoutOption(parentExited, timeout));
		}),
	);

const devOriginsWith = (env: Record<string, string>) =>
	Effect.gen(function* () {
		const { allowedOrigins } = yield* DaemonConfig;
		return allowedOrigins;
	}).pipe(
		Effect.provide(DaemonConfig.devLayer),
		Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
		Effect.runPromise,
	);

describe("DaemonConfig", () => {
	test("reads the token from the first line of stdin", async () => {
		const result = await configFromStdin(TEST_TOKEN.slice(0, 10), `${TEST_TOKEN.slice(10)}\n`, "ignored\n");
		expect(result._tag).toBe("Success");
		if (result._tag === "Success") {
			expect(Redacted.value(result.success.token)).toBe(TEST_TOKEN);
		}
	});

	// The desktop shell always sends 32 random bytes as hex, so anything else did not come from it.
	test("refuses a token that is not 32 bytes of hex", async () => {
		for (const token of ["abc", `${TEST_TOKEN}0`, TEST_TOKEN.toUpperCase().replace(/./, "G")]) {
			const result = await configFromStdin(`${token}\n`);
			expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DaemonTokenInvalidError" } });
		}
	});

	test("allows only the desktop app's pages by default", async () => {
		const result = await configFromStdin(`${TEST_TOKEN}\n`);
		expect(result).toMatchObject({ _tag: "Success", success: { allowedOrigins: TAURI_ORIGINS } });
	});

	test("in dev, allows the web dev server on localhost and on 127.0.0.1", async () => {
		expect(await devOriginsWith({})).toEqual([...TAURI_ORIGINS, "http://localhost:3000", "http://127.0.0.1:3000"]);
		expect(await devOriginsWith({ OCTOPUS_DAEMON_DEV_ORIGIN: "http://127.0.0.1:3100" })).toEqual([
			...TAURI_ORIGINS,
			"http://localhost:3100",
			"http://127.0.0.1:3100",
		]);
	});

	test("fails when stdin closes without a token", async () => {
		const result = await configFromStdin();
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure._tag).toBe("DaemonTokenMissingError");
		}
	});

	test("reports the parent gone once stdin closes after the token", async () => {
		const result = await parentExitedWithin(stdinOf(`${TEST_TOKEN}\n`), Duration.seconds(1));
		expect(result).toMatchObject({ _tag: "Success", success: true });
	});

	test("keeps waiting while stdin stays open", async () => {
		const result = await parentExitedWithin(
			Stream.concat(stdinOf(`${TEST_TOKEN}\n`), Stream.never),
			Duration.millis(50),
		);
		expect(result).toMatchObject({ _tag: "Success", success: false });
	});
});
