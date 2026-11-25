import { runInTempDir } from "../testing/runServiceTest.ts";
import { FAILED_LINE_PREFIX } from "./runDaemon.ts";
import { describe, expect, test } from "bun:test";
import { ChildProcess } from "effect/process";
import { Effect, Stream } from "effect";
import { join } from "node:path";

const DAEMON_DIR = join(import.meta.dir, "..", "..");

describe("runDaemon", () => {
	test("prints why it failed for the desktop shell", async () => {
		const result = await runInTempDir((dataDir) =>
			Effect.gen(function* () {
				const handle = yield* ChildProcess.make("bun", ["src/main.ts"], {
					cwd: DAEMON_DIR,
					stdin: Stream.empty,
					env: { OCTOPUS_DATA_DIR: dataDir },
					extendEnv: true,
				});
				const output = yield* handle.stdout.pipe(Stream.decodeText, Stream.mkString);
				return { code: Number(yield* handle.exitCode), output };
			}),
		);
		expect(result.code).toBe(1);
		expect(result.output).toContain(
			`${FAILED_LINE_PREFIX}octopusd reads its token from the first line of stdin. Start it from the Octopus app.`,
		);
	}, 20_000);
});
