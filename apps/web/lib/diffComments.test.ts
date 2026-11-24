import { codeIn, diffCommentsMessage, pickLines } from "./diffComments.ts";
import { describe, expect, test } from "bun:test";
import { DiffFile } from "@repo/contracts/Git";

const file = new DiffFile({
	path: "src/a.ts",
	oldPath: null,
	status: "modified",
	additions: 2,
	deletions: 1,
	content: {
		kind: "text",
		hunks: [
			{
				header: "@@ -1,3 +1,4 @@",
				lines: [
					{ kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
					{ kind: "delete", oldLine: 2, newLine: null, text: "const b = 2;" },
					{ kind: "add", oldLine: null, newLine: 2, text: "const b = 3;" },
					{ kind: "add", oldLine: null, newLine: 3, text: "const c = 4;" },
					{ kind: "context", oldLine: 3, newLine: 4, text: "export { a };" },
				],
			},
		],
	},
});

describe("diff comments", () => {
	test("a shift-click stretches the pick within one file and side, anything else starts over", () => {
		const first = { path: "src/a.ts", side: "new", start: 3, end: 3 } as const;
		expect(pickLines(first, { ...first, start: 1, end: 1 }, true)).toEqual({ ...first, start: 1, end: 3 });
		expect(pickLines(first, { ...first, side: "old", start: 2, end: 2 }, true)).toEqual({
			...first,
			side: "old",
			start: 2,
			end: 2,
		});
		expect(pickLines(first, { ...first, start: 1, end: 1 }, false)).toEqual({ ...first, start: 1, end: 1 });
	});

	test("takes the picked lines from their own side only", () => {
		expect(codeIn(file, { path: "src/a.ts", side: "new", start: 1, end: 3 })).toEqual([
			"const a = 1;",
			"const b = 3;",
			"const c = 4;",
		]);
		expect(codeIn(file, { path: "src/a.ts", side: "old", start: 2, end: 2 })).toEqual(["const b = 2;"]);
	});

	test("writes every comment with its place and code", () => {
		expect(
			diffCommentsMessage([
				{
					id: "1",
					path: "src/a.ts",
					side: "new",
					start: 2,
					end: 3,
					code: ["const b = 3;", "const c = 4;"],
					text: "Why 3? ",
				},
				{ id: "2", path: "src/a.ts", side: "old", start: 2, end: 2, code: ["const b = 2;"], text: "Keep this." },
			]),
		).toBe(
			[
				"Address these comments on the changes in this workspace.",
				"",
				"src/a.ts:2-3",
				"> const b = 3;",
				"> const c = 4;",
				"Why 3?",
				"",
				"src/a.ts:2 (removed)",
				"> const b = 2;",
				"Keep this.",
			].join("\n"),
		);
	});
});
