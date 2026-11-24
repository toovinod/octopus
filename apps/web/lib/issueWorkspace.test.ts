import { issueBranchName, issueMessage } from "./issueWorkspace.ts";
import { OpenIssue } from "@repo/contracts/Workspace";
import { describe, expect, test } from "bun:test";
import { isWorkspaceName } from "./names.ts";

const issue = (title: string, body = "") =>
	new OpenIssue({ number: 12, title, body, url: "https://github.com/acme/repo/issues/12" });

describe("issueBranchName", () => {
	test("slugs the title after the number", () => {
		expect(issueBranchName(issue("Crash on save (macOS)!"))).toBe("issue-12-crash-on-save-macos");
	});

	test("keeps only the number when the title has no letters or digits", () => {
		expect(issueBranchName(issue("???"))).toBe("issue-12");
	});

	test("stays a valid workspace name when the title is long", () => {
		const name = issueBranchName(issue("a ".repeat(100)));
		expect(name.length).toBeLessThanOrEqual(63);
		expect(isWorkspaceName(name)).toBe(true);
	});
});

describe("issueMessage", () => {
	test("puts the title, link and body in one message", () => {
		expect(issueMessage(issue("Crash on save", " Steps:\n1. Save\n"))).toBe(
			"Resolve issue #12: Crash on save\n\nhttps://github.com/acme/repo/issues/12\n\nSteps:\n1. Save",
		);
	});

	test("leaves out an empty body", () => {
		expect(issueMessage(issue("Crash"))).toBe("Resolve issue #12: Crash\n\nhttps://github.com/acme/repo/issues/12");
	});
});
