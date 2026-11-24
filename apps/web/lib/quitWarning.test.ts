import type { AgentSession } from "@repo/contracts/AgentSession";
import { describe, expect, test } from "bun:test";
import { quitWarning } from "./quitWarning.ts";

const withStatuses = (...statuses: ReadonlyArray<AgentSession["status"]>) => statuses.map((status) => ({ status }));

describe("quitWarning", () => {
	test("says nothing when no turn runs and no approval waits", () => {
		expect(quitWarning([])).toBeNull();
		expect(quitWarning(withStatuses("idle", "interrupted", "failed"))).toBeNull();
	});

	test("counts running turns and pending approvals", () => {
		expect(quitWarning(withStatuses("running"))).toBe("1 chat is working. Quitting stops it.");
		expect(quitWarning(withStatuses("running", "running", "awaitingApproval", "idle"))).toBe(
			"2 chats are working and 1 chat needs your approval. Quitting stops them.",
		);
	});
});
