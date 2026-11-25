import { runInTempDir } from "../testing/runServiceTest.ts";
import { describe, expect, test } from "bun:test";
import { holdsForkCode } from "./forkBranch.ts";
import { join } from "node:path";

describe("holdsForkCode", () => {
	test("counts a folder git cannot read as a fork's", async () => {
		const fork = await runInTempDir((tempDir) => holdsForkCode({ fromFork: false, path: join(tempDir, "missing") }));
		expect(fork).toBe(true);
	});
});
