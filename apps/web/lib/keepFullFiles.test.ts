import { keepFullFiles } from "./keepFullFiles.ts";
import { describe, expect, test } from "bun:test";
import { DiffFile } from "@repo/contracts/Git";

const big = (additions: number, content: DiffFile["content"]) =>
	new DiffFile({ path: "big.json", oldPath: null, status: "modified", additions, deletions: 0, content });

const full = big(900, { kind: "text", hunks: [{ header: "@@ -0,0 +1,900 @@", lines: [] }] });
const summary = big(900, { kind: "tooLarge" });
const loaded = new Set(["big.json"]);

describe("keepFullFiles", () => {
	test("keeps a file the user loaded in full when a reload summarizes it again unchanged", () => {
		expect(keepFullFiles([full], [summary], loaded)).toEqual({ files: [full], stale: [] });
	});

	test("asks again for a loaded file whose changes moved on", () => {
		const grown = big(950, { kind: "tooLarge" });
		expect(keepFullFiles([full], [grown], loaded)).toEqual({ files: [grown], stale: ["big.json"] });
	});

	test("leaves files nobody loaded in full as the reload sent them", () => {
		expect(keepFullFiles([summary], [summary], loaded)).toEqual({ files: [summary], stale: [] });
	});

	test("leaves a file that grew past the limit by itself summarized", () => {
		expect(keepFullFiles([full], [summary], new Set())).toEqual({ files: [summary], stale: [] });
	});
});
