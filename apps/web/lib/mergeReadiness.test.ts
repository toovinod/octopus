import { mergeReadiness } from "./mergeReadiness.ts";
import { describe, expect, test } from "bun:test";

const pr = (isDraft: boolean, failing: number, pending: number) => ({
	isDraft,
	checks: { passing: 1, failing, pending },
});

describe("mergeReadiness", () => {
	test("lets a ready pull request with passing checks merge", () => {
		expect(mergeReadiness(pr(false, 0, 0))).toEqual({ kind: "ready" });
	});

	test("blocks a draft", () => {
		expect(mergeReadiness(pr(true, 0, 0))).toEqual({
			kind: "blocked",
			reason: "A draft cannot be merged. Mark it ready for review on GitHub first.",
		});
	});

	test("warns before merging with failing or pending checks", () => {
		expect(mergeReadiness(pr(false, 2, 0))).toEqual({ kind: "warn", warning: "2 checks are failing." });
		expect(mergeReadiness(pr(false, 0, 1))).toEqual({ kind: "warn", warning: "1 check is still running." });
		expect(mergeReadiness(pr(false, 1, 3))).toEqual({
			kind: "warn",
			warning: "1 check is failing. 3 checks are still running.",
		});
	});
});
