import { describe, expect, test } from "bun:test";
import { commitPaths } from "./commitPaths.ts";

const files = [
	{ path: "a.ts", oldPath: null },
	{ path: "b.ts", oldPath: "old-b.ts" },
	{ path: "c.ts", oldPath: null },
];

describe("commitPaths", () => {
	test("commits every change while every file is ticked", () => {
		expect(commitPaths(files, new Set())).toBeNull();
	});

	test("commits only the ticked files, with a rename's old path", () => {
		expect(commitPaths(files, new Set(["a.ts"]))).toEqual(["b.ts", "old-b.ts", "c.ts"]);
		expect(commitPaths(files, new Set(["a.ts", "b.ts", "c.ts"]))).toEqual([]);
	});
});
