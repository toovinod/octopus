import { workspaceLinkPath } from "./workspaceLinkPath.ts";
import { describe, expect, test } from "bun:test";

const root = "/home/ana/app";

describe("workspaceLinkPath", () => {
	test("reads relative and in-workspace absolute links as workspace paths", () => {
		expect(workspaceLinkPath("src/app.ts", root)).toBe("src/app.ts");
		expect(workspaceLinkPath("./src/app.ts:12", root)).toBe("src/app.ts");
		expect(workspaceLinkPath("src/app.ts#L4", root)).toBe("src/app.ts");
		expect(workspaceLinkPath("/home/ana/app/src/my%20file.ts", root)).toBe("src/my file.ts");
	});

	test("leaves web links and paths outside the workspace alone", () => {
		expect(workspaceLinkPath("https://example.com/a.ts", root)).toBeNull();
		expect(workspaceLinkPath("mailto:ana@example.com", root)).toBeNull();
		expect(workspaceLinkPath("#section", root)).toBeNull();
		expect(workspaceLinkPath("/etc/passwd", root)).toBeNull();
		expect(workspaceLinkPath("../other/a.ts", root)).toBeNull();
		expect(workspaceLinkPath("/home/ana/app-other/a.ts", root)).toBeNull();
		expect(workspaceLinkPath("100%.md", root)).toBeNull();
	});
});
