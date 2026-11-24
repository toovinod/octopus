import type { OpenIssue } from "@repo/contracts/Workspace";

const MAX_NAME = 63;

// A workspace name, and so a branch, for working on an issue: "issue-12-crash-on-save".
export const issueBranchName = (issue: Pick<OpenIssue, "number" | "title">) => {
	const prefix = `issue-${issue.number}`;
	const slug = issue.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const name = slug === "" ? prefix : `${prefix}-${slug}`;
	return name.slice(0, MAX_NAME).replace(/[-._]+$/, "");
};

// The first message for the agent: the issue as the user would paste it, with its link for context.
export const issueMessage = (issue: OpenIssue) => {
	const body = issue.body.trim();
	return [`Resolve issue #${issue.number}: ${issue.title}`, issue.url, ...(body === "" ? [] : [body])].join("\n\n");
};
