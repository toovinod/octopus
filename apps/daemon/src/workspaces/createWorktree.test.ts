import { worktreeFolderName } from "./createWorktree.ts";
import { describe, expect, test } from "bun:test";

describe("worktreeFolderName", () => {
	test("keeps a plain lowercase branch name as it is", () => {
		expect(worktreeFolderName("feature-login")).toBe("feature-login");
	});

	// APFS and NTFS compare names without case, so two such folders would be one.
	test("gives branches that differ only in case folders that differ in more than case", () => {
		const names = ["feature", "Feature", "FEATURE"].map((branch) => worktreeFolderName(branch).toLowerCase());
		expect(new Set(names).size).toBe(3);
	});
});
