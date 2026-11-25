import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Follow } from "./daemonRuntime.ts";
import { Predicate } from "effect";

const project = { id: "p", name: "app", path: "/app", defaultBranch: "main", trusted: false };
const workspace = { id: "w", projectId: "p", status: "active", kind: "worktree", name: "fix", path: "/app-fix" };
const session = {
	id: "s",
	workspaceId: "w",
	agent: "claude",
	status: "idle",
	model: "replay",
	effort: null,
	mode: "default",
	title: null,
	createdAt: "1",
	updatedAt: "1",
};

const drop = { _tag: "RpcClientError", message: "SocketCloseError: closed" };
const internal = { _tag: "DaemonInternalError", message: "Octopus could not list chats." };

// The daemon answers each sendMessage with the next of these outcomes.
const outcomes: Array<"ok" | "busy"> = [];
const sent: Array<string> = [];
// Each listProjects call takes the next of these, and succeeds once they run out.
const listFailures: Array<unknown> = [];
let listCalls = 0;
let agentLists = 0;
// Every stream the store follows, newest last.
const follows: Array<{ readonly name: string; readonly handlers: Follow<unknown> }> = [];

// Each settings or rename call waits for the test to settle it.
let settleUpdate: (outcome: unknown) => void = () => {};
const pendingUpdate = () =>
	new Promise((resolve, reject) => {
		settleUpdate = (outcome) => (Predicate.hasProperty(outcome, "_tag") ? reject(outcome) : resolve(outcome));
	});

const daemon = {
	updateSessionSettings: pendingUpdate,
	renameSession: pendingUpdate,
	listProjects: () => {
		listCalls++;
		const failure = listFailures.shift();
		return failure === undefined ? [project] : Promise.reject(failure);
	},
	listWorkspaces: () => [workspace],
	listSessions: () => [session],
	listAgents: () => {
		agentLists++;
		return [];
	},
	loadSessionHistory: () => [],
	removeProject: () => undefined,
	revertToMessage: () => [{ path: "README.md", change: "modified" }],
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
			name: open({
				watchSessions: () => "watchSessions",
				watchAgentLogins: () => "watchAgentLogins",
				subscribeSession: () => "subscribeSession",
			}),
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
	isConnectionDrop,
	reconnectDelay,
	removeProject,
	retryFailedSend,
	renameSession,
	revertToMessage,
	sendMessage,
	updateSessionSettings,
} = await import("./store.ts");

// After the import, since sonner skips injecting its styles only when there is no document. boot sets the root font
// size and notifications read focus and visibility.
Object.assign(globalThis, {
	document: { documentElement: { style: {} }, visibilityState: "visible", hasFocus: () => true },
});

const lastWatch = () => follows.filter((follow) => follow.name === "watchSessions").at(-1)?.handlers;
const watchCount = () => follows.filter((follow) => follow.name === "watchSessions").length;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("reconnecting", () => {
	test("waits longer after each failed attempt, with jitter, up to 30 s", () => {
		expect(reconnectDelay(0, () => 1)).toBe(500);
		expect(reconnectDelay(0, () => 0)).toBe(250);
		expect(reconnectDelay(3, () => 1)).toBe(4000);
		expect(reconnectDelay(20, () => 1)).toBe(30_000);
		expect(isConnectionDrop(drop)).toBe(true);
		expect(isConnectionDrop(internal)).toBe(false);
	});

	beforeEach(async () => {
		spyOn(Math, "random").mockReturnValue(0);
		listCalls = 0;
		await boot();
		expect(getState().connection.status).toBe("ready");
	});

	test("a dropped watch reloads the projects, then watches again", async () => {
		const watches = watchCount();
		listFailures.push(drop);
		lastWatch()?.onEnd?.(drop);
		expect(getState().connection.status).toBe("reconnecting");
		// 250 ms for the failed reload, 500 ms for the one that works.
		await sleep(900);
		expect(listCalls).toBe(3);
		expect(getState().connection.status).toBe("ready");
		expect(watchCount()).toBe(watches + 1);
	});

	test("a watch the daemon ends, or a daemon error, is not retried", async () => {
		const watches = watchCount();
		lastWatch()?.onEnd?.(null);
		lastWatch()?.onEnd?.(internal);
		await sleep(400);
		expect(listCalls).toBe(1);
		expect(getState().connection.status).toBe("ready");
		expect(watchCount()).toBe(watches);
	});
});

describe("reverting to a message", () => {
	test("bumps the workspace's revert count so its diff reloads", async () => {
		await boot();
		const before = getState().reverts.w ?? 0;
		expect(await revertToMessage("s", "m")).toBe(true);
		expect(getState().reverts.w).toBe(before + 1);
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

describe("signing in", () => {
	test("a finished sign-in refreshes the agents without being asked", async () => {
		await boot();
		const watch = follows.filter((follow) => follow.name === "watchAgentLogins").at(-1)?.handlers;
		await sleep(0);
		const before = agentLists;
		watch?.onItem({ agent: "claude", success: true });
		await sleep(0);
		expect(watch).toBeDefined();
		expect(agentLists).toBe(before + 1);
	});
});

describe("session changes", () => {
	const running = { ...session, status: "running", updatedAt: "3" };

	test("a refused change undoes only its own fields, keeping a newer status", async () => {
		await boot();
		const change = updateSessionSettings("s", { mode: "plan" });
		expect(getState().sessions.s?.mode).toBe("plan");
		lastWatch()?.onItem(running);
		settleUpdate({ _tag: "DaemonInternalError", message: "Octopus could not save the settings." });
		await change;
		expect(getState().sessions.s).toMatchObject({ status: "running", mode: "default" });
	});

	test("a reply older than a watch update does not step the session back", async () => {
		await boot();
		const rename = renameSession("s", "Fix the build");
		lastWatch()?.onItem({ ...running, title: "Fix the build" });
		settleUpdate({ ...session, status: "idle", title: "Fix the build", updatedAt: "2" });
		await rename;
		expect(getState().sessions.s).toMatchObject({ status: "running", title: "Fix the build" });
	});
});
