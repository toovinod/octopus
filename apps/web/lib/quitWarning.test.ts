import type { AgentSession } from "@repo/contracts/AgentSession";
import { describe, expect, test } from "bun:test";
import { quitWarning } from "./quitWarning.ts";

const idle = { busyTerminals: 0, runningScripts: 0 };

const withStatuses = (...statuses: ReadonlyArray<AgentSession["status"]>) => statuses.map((status) => ({ status }));

describe("quitWarning", () => {
	test("says nothing when no turn runs and no approval waits", () => {
		expect(quitWarning([], idle)).toBeNull();
		expect(quitWarning(withStatuses("idle", "interrupted", "failed"), idle)).toBeNull();
	});

	test("counts running turns and pending approvals", () => {
		expect(quitWarning(withStatuses("running"), idle)).toBe("1 chat is working. Quitting stops it.");
		expect(quitWarning(withStatuses("running", "running", "awaitingApproval", "idle"), idle)).toBe(
			"2 chats are working and 1 chat needs your approval. Quitting stops them.",
		);
	});

	test("counts terminals running a command and scripts still going", () => {
		expect(quitWarning([], { busyTerminals: 1, runningScripts: 0 })).toBe(
			"1 terminal is running a command. Quitting stops it.",
		);
		expect(quitWarning(withStatuses("running"), { busyTerminals: 2, runningScripts: 1 })).toBe(
			"1 chat is working, 2 terminals are running a command and 1 script is running. Quitting stops them.",
		);
	});
});
