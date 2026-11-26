import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSession } from "@repo/contracts/AgentSession";
import { errorMessage, errorTag } from "./errorMessage.ts";
import { draftOf, keepDraft } from "./drafts.ts";
import type { Follow } from "./daemonRuntime.ts";
import { toast as sonnerToast } from "sonner";
import { Predicate } from "effect";

// Math.random is shared by every test file in the run, so a test that pins it puts it back afterwards.
let restoreRandom = () => {};
const pinRandom = () => {
	const random = spyOn(Math, "random").mockReturnValue(0);
	restoreRandom = () => random.mockRestore();
};
afterEach(() => restoreRandom());

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

interface HistoryRequest {
	readonly sessionId: string;
	readonly beforeSequence: number | null;
}
// Answers loadSessionHistory. Tests that change it put it back.
let history: (request: HistoryRequest) => unknown = () => [];
const historyCalls: Array<string> = [];
// Each listSessions call takes the next of these, and lists the one session once they run out.
const sessionLists: Array<Array<unknown>> = [];
const userMessage = (sequence: number) => ({
	sequence,
	event: { type: "user.message", itemId: `u${sequence}`, text: "hi", attachments: [] },
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
	listSessions: () => sessionLists.shift() ?? [session],
	listAgents: () => {
		agentLists++;
		return [{ kind: "claude", availability: { status: "ready" }, defaultModel: "replay", models: [{ id: "replay" }] }];
	},
	createSession: pendingUpdate,
	loadSessionHistory: (request: HistoryRequest) => {
		historyCalls.push(`${request.sessionId}:${request.beforeSequence}`);
		return history(request);
	},
	removeProject: () => undefined,
	interruptSession: () => [],
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
	// mock.module replaces the module for every test file in the run, so these must be the real ones.
	errorMessage,
	errorTag,
}));

const {
	boot,
	closeTab,
	discardFailedSend,
	failedSendsOf,
	getState,
	interruptSession,
	queuedOf,
	isConnectionDrop,
	loadOlderEvents,
	newChat,
	reconnectDelay,
	removeProject,
	retryFailedSend,
	renameSession,
	revertToMessage,
	selectSession,
	sendMessage,
	updateSessionSettings,
	workingChats,
} = await import("./store.ts");

// After the import, since sonner skips injecting its styles only when there is no document. boot sets the root font
// size and notifications read focus and visibility.
Object.assign(globalThis, {
	document: { documentElement: { style: {} }, visibilityState: "visible", hasFocus: () => true },
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
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
		pinRandom();
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

		keepDraft("s", { text: "half a thought", images: [] });
		expect(await removeProject("p")).toBe(true);
		expect(draftOf("s").text).toBe("");
		const state = getState();
		expect(state.projects).toEqual({});
		expect(state.workspaces).toEqual({});
		expect(state.sessions).toEqual({});
		expect(state.selectedWorkspaceId).toBeNull();
		expect(state.selectedSessionId).toBeNull();
		expect(state.chat).toBeNull();
	});

	test("forgets the queued messages and closed tabs of its chats", async () => {
		await boot();
		await sleep(0);
		lastWatch()?.onItem({ ...session, status: "running", updatedAt: "7" });
		await sendMessage("s", "later", [], false);
		closeTab("s");
		expect(queuedOf(getState(), "s")).toHaveLength(1);
		expect(getState().closedTabs.has("s")).toBe(true);
		expect(await removeProject("p")).toBe(true);
		expect(getState().queued).toEqual({});
		expect(getState().closedTabs.size).toBe(0);
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

describe("workingChats", () => {
	test("changes only when a chat in the workspace starts or stops working", () => {
		const of = (
			...sessions: ReadonlyArray<{ readonly status: AgentSession["status"]; readonly workspaceId?: string }>
		) =>
			workingChats(
				sessions.map((changes, index) => ({ id: String(index), workspaceId: "w", ...changes })),
				"w",
			);
		expect(of({ status: "idle" }, { status: "failed" })).toBe("");
		expect(of({ status: "running" }, { status: "awaitingApproval" })).toBe("0 1");
		expect(of({ status: "running", workspaceId: "other" })).toBe("");
	});
});

describe("new chats", () => {
	test("a chat that arrives after the user moved on does not take the selection", async () => {
		await boot();
		await sleep(0);
		lastWatch()?.onItem({ ...session, id: "t", createdAt: "2" });
		const created = newChat("w");
		selectSession("t");
		settleUpdate({ ...session, id: "n", createdAt: "3" });
		expect(await created).toBe("n");
		expect(getState().selectedSessionId).toBe("t");
		expect(getState().sessions.n).toBeDefined();
	});

	test("a chat that arrives while the selection stayed opens", async () => {
		await boot();
		await sleep(0);
		const created = newChat("w");
		settleUpdate({ ...session, id: "m", createdAt: "4" });
		await created;
		expect(getState().selectedSessionId).toBe("m");
	});
});

const subscriptions = () => follows.filter((follow) => follow.name === "subscribeSession");

describe("following the open chat", () => {
	test("a dropped chat stream retries with a growing delay", async () => {
		pinRandom();
		await boot();
		await sleep(0);
		const before = subscriptions().length;
		subscriptions().at(-1)?.handlers.onEnd?.(drop);
		await sleep(300);
		expect(subscriptions().length).toBe(before + 1);
		subscriptions().at(-1)?.handlers.onEnd?.(drop);
		await sleep(300);
		expect(subscriptions().length).toBe(before + 1);
		await sleep(300);
		expect(subscriptions().length).toBe(before + 2);
	});
});

describe("older history", () => {
	test("an empty older page stops the chat asking again", async () => {
		history = ({ beforeSequence }) => (beforeSequence === null ? [userMessage(5)] : []);
		await boot();
		lastWatch()?.onItem({ ...session, id: "h", createdAt: "2" });
		selectSession("h");
		await sleep(0);
		historyCalls.length = 0;
		await loadOlderEvents();
		await loadOlderEvents();
		expect(historyCalls).toEqual(["h:5"]);
		expect(getState().chat?.firstSequence).toBe(0);
		history = () => [];
	});

	test("a page still loading for the last chat does not hold up the next", async () => {
		history = ({ sessionId, beforeSequence }) =>
			beforeSequence === null ? [userMessage(sessionId === "a" ? 5 : 7)] : new Promise(() => {});
		await boot();
		lastWatch()?.onItem({ ...session, id: "a", createdAt: "2" });
		lastWatch()?.onItem({ ...session, id: "t", createdAt: "3" });
		selectSession("a");
		await sleep(0);
		void loadOlderEvents();
		expect(historyCalls.at(-1)).toBe("a:5");
		selectSession("t");
		await sleep(0);
		historyCalls.length = 0;
		void loadOlderEvents();
		expect(historyCalls).toEqual(["t:7"]);
		history = () => [];
	});
});

describe("queued messages", () => {
	const queuedTexts = () => queuedOf(getState(), "s").map(({ text }) => text);
	const started = (sequence: number, text: string) =>
		subscriptions()
			.at(-1)
			?.handlers.onItem({
				sessionId: "s",
				sequence,
				event: { type: "user.message", itemId: `u${sequence}`, text, attachments: [] },
				createdAt: "1",
			});

	test("a message sent to a busy chat shows as queued until its turn starts or the chat stops working", async () => {
		await boot();
		await sleep(0);
		lastWatch()?.onItem({ ...session, status: "running", updatedAt: "5" });
		await sendMessage("s", "next", [], false);
		await sendMessage("s", "after", [], false);
		expect(queuedOf(getState(), "s")).toMatchObject([
			{ text: "next", imageCount: 0 },
			{ text: "after", imageCount: 0 },
		]);
		started(10, "next");
		await sleep(5);
		expect(queuedTexts()).toEqual(["after"]);
		lastWatch()?.onItem({ ...session, status: "idle", updatedAt: "6" });
		expect(queuedTexts()).toEqual([]);
	});

	test("a message sent to an idle chat, or one the daemon refuses, is not shown as queued", async () => {
		await boot();
		await sleep(0);
		await sendMessage("s", "now", [], false);
		expect(queuedTexts()).toEqual([]);
		lastWatch()?.onItem({ ...session, status: "running", updatedAt: "5" });
		outcomes.push("busy");
		await sendMessage("s", "too many", [], false);
		expect(queuedTexts()).toEqual([]);
		expect(failedSendsOf(getState(), "s").map(({ text }) => text)).toEqual(["too many"]);
		discardFailedSend("s", failedSendsOf(getState(), "s")[0]?.id ?? -1);
	});

	test("a stop takes back the queued messages", async () => {
		await boot();
		await sleep(0);
		lastWatch()?.onItem({ ...session, status: "running", updatedAt: "5" });
		await sendMessage("s", "next", [], false);
		await interruptSession("s");
		expect(queuedTexts()).toEqual([]);
	});
});

describe("reconnecting after deletions", () => {
	test("drops chats the daemon no longer lists, and their selection", async () => {
		pinRandom();
		await boot();
		expect(getState().selectedSessionId).toBe("s");
		sessionLists.push([]);
		lastWatch()?.onEnd?.(drop);
		await sleep(300);
		expect(getState().sessions).toEqual({});
		expect(getState().selectedSessionId).toBeNull();
		expect(getState().chat).toBeNull();
	});
});

describe("watching sign-ins", () => {
	test("says so when the watch fails for another reason than a dropped socket", async () => {
		const shown = spyOn(sonnerToast, "error");
		await boot();
		const watch = follows.filter((follow) => follow.name === "watchAgentLogins").at(-1)?.handlers;
		watch?.onEnd?.(drop);
		expect(shown).not.toHaveBeenCalled();
		watch?.onEnd?.(internal);
		expect(shown).toHaveBeenCalledWith("Sign-in results stopped arriving. Restart Octopus to see them again.");
		shown.mockRestore();
	});
});
