import type { PullRequest } from "@repo/contracts/Git";

export type MergeReadiness =
	| { readonly kind: "ready" }
	| { readonly kind: "warn"; readonly warning: string }
	| { readonly kind: "blocked"; readonly reason: string };

const checks = (n: number, verb: string) => `${n} ${n === 1 ? "check is" : "checks are"} ${verb}.`;

// GitHub refuses to merge a draft. Failing or running checks may not be required, so they only ask first.
export const mergeReadiness = (pullRequest: Pick<PullRequest, "isDraft" | "checks">): MergeReadiness => {
	if (pullRequest.isDraft) {
		return { kind: "blocked", reason: "A draft cannot be merged. Mark it ready for review on GitHub first." };
	}
	const { failing, pending } = pullRequest.checks;
	const parts = [
		failing === 0 ? null : checks(failing, "failing"),
		pending === 0 ? null : checks(pending, "still running"),
	].filter((part) => part !== null);
	return parts.length === 0 ? { kind: "ready" } : { kind: "warn", warning: parts.join(" ") };
};
