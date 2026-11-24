import { rankFilePaths } from "./rankFilePaths.ts";
import { describe, expect, test } from "bun:test";

const paths = [
	"src/components/Composer.tsx",
	"docs/composing.md",
	"src/lib/store.ts",
	"src/compose/index.ts",
	"README.md",
];

describe("rankFilePaths", () => {
	test("puts file names that start with the query first, then ones that contain it, then paths", () => {
		expect(rankFilePaths(paths, "comp", 10)).toEqual([
			"docs/composing.md",
			"src/components/Composer.tsx",
			"src/compose/index.ts",
		]);
	});

	test("matches letters in order and ignores case", () => {
		expect(rankFilePaths(paths, "SLS", 10)).toEqual(["src/lib/store.ts"]);
	});

	test("keeps the shortest paths when the query is empty, up to the limit", () => {
		expect(rankFilePaths(paths, "", 2)).toEqual(["README.md", "src/lib/store.ts"]);
	});
});
