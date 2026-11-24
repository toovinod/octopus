import { describe, expect, mock, test } from "bun:test";
import type { Follow } from "./daemonRuntime.ts";
import { Predicate } from "effect";

const project = { id: "p", name: "app", path: "/app", defaultBranch: "main", trusted: false };
const workspace = { id: "w", projectId: "p", status: "active", kind: "worktree", name: "fix", path: "/app-fix" };
const session = { id: "s", workspaceId: "w", agent: "claude", status: "idle", createdAt: "1", updatedAt: "1" };

// The daemon answers each sendMessage with the next of these outcomes.
const outcomes: Array<"ok" | "busy"> = [];
const sent: Array<string> = [];
// Every stream the store follows, newest last.
const follows: Array<{ readonly name: string; readonly handlers: Follow<unknown> }> = [];

const daemon = {
	listProjects: () => [project],
	listWorkspaces: () => [workspace],
	listSessions: () => [session],
	listAgents: () => [],
	loadSessionHistory: () => [],
	removeProject: () => undefined,
	sendMessage: ({ text }: { readonly text: string }) => {
		sent.push(text);
		return outcomes.shift() === "busy"
			? Promise.reject({ _tag: "SessionBusyError", message: "The agent is busy. Try again." })
			: undefined;
	},
};

mock.module("./daemonRuntime.ts", () => ({
	callDaemon: (call: (client: typeof daemon) => unknown) => Promise.resolve(call(daemon)),
	followDaemon: (open: (client: Record<string, () => string>) => string, handlers: Follow<unknown>) => {
		follows.push({
			name: open({ watchSessions: () => "watchSessions", subscribeSession: () => "subscribeSession" }),
			handlers,
		});
		return () => {};
	},
	errorMessage: (error: { readonly message: string }) => error.message,
	// mock.module replaces the module for every test file in the run, so this must behave like the real one.
	errorTag: (error: unknown) =>
		Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : null,
}));

const {
	boot,
	discardFailedSend,
	failedSendsOf,
	getState,
	removeProject,
	retryFailedSend,
	sendMessage,
} = await import("./store.ts");

// After the import, since sonner skips injecting its styles only when there is no document. boot sets the root font
// size and notifications read focus and visibility.
Object.assign(globalThis, {
	document: { documentElement: { style: {} }, visibilityState: "visible", hasFocus: () => true },
});

describe("failed sends", () => {
	test("keep a refused message per chat until it is retried or discarded", async () => {
		outcomes.push("busy", "busy", "ok");
		expect(await sendMessage("a", "first", [], false)).toBe(false);
		expect(await sendMessage("a", "second", [], false)).toBe(false);
		expect(failedSendsOf(getState(), "a").map(({ text, error }) => [text, error])).toEqual([
			["first", "The agent is busy. Try again."],
			["second", "The agent is busy. Try again."],
		]);
		expect(failedSendsOf(getState(), "b")).toEqual([]);

		const [first, second] = failedSendsOf(getState(), "a");
		expect(await retryFailedSend("a", first?.id ?? -1, false)).toBe(true);
		expect(failedSendsOf(getState(), "a").map(({ text }) => text)).toEqual(["second"]);

		discardFailedSend("a", second?.id ?? -1);
		expect(getState().failedSends).toEqual({});
		expect(sent).toEqual(["first", "second", "first"]);
	});

	test("a retry that fails again keeps the message", async () => {
		outcomes.push("busy", "busy");
		await sendMessage("c", "hello", [], true);
		const [failed] = failedSendsOf(getState(), "c");
		expect(await retryFailedSend("c", failed?.id ?? -1, true)).toBe(false);
		expect(failedSendsOf(getState(), "c").map(({ text }) => text)).toEqual(["hello"]);
	});
});

describe("removing a project", () => {
	test("drops its workspaces, their chats and the selection", async () => {
		await boot();
		expect(getState().selectedSessionId).toBe("s");
		expect(getState().chat?.sessionId).toBe("s");

		expect(await removeProject("p")).toBe(true);
		const state = getState();
		expect(state.projects).toEqual({});
		expect(state.workspaces).toEqual({});
		expect(state.sessions).toEqual({});
		expect(state.selectedWorkspaceId).toBeNull();
		expect(state.selectedSessionId).toBeNull();
		expect(state.chat).toBeNull();
	});
});
