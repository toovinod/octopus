import {
	applyFontSize,
	defaultSettings,
	loadSettings,
	readStored,
	type Settings,
	saveSettings,
	writeStored,
} from "./settings.ts";
import type { AgentAuthMode, AgentInfo, AgentKind, AgentSession } from "@repo/contracts/AgentSession";
import type { ApprovalDecision, QuestionAnswers, PlanAnswer } from "@repo/contracts/AgentEvent";
import { applyEvents, type ChatState, emptyChat, prependEvents } from "./chatReducer.ts";
import { callDaemon, errorMessage, errorTag, followDaemon } from "./daemonRuntime.ts";
import type { CreateWorkspaceInput } from "@repo/contracts/WorkspaceRpcs";
import type { SessionEvent } from "@repo/contracts/SessionEvent";
import { playChime, showNotification } from "./desktop.ts";
import type { Workspace } from "@repo/contracts/Workspace";
import type { Project } from "@repo/contracts/Project";
import type { DraftImage } from "./images.ts";
import { useSyncExternalStore } from "react";
import { releaseDrafts } from "./drafts.ts";
import { toast as showToast } from "sonner";
import { Redacted } from "effect";

export type PanelTab = "diff" | "files" | "terminal" | "run" | "pr";

export type DialogState =
	| { readonly kind: "palette" }
	| { readonly kind: "newProject" }
	| { readonly kind: "newWorkspace"; readonly projectId: string }
	| { readonly kind: "removeProject"; readonly projectId: string }
	| { readonly kind: "revert"; readonly sessionId: string; readonly messageId: string }
	| { readonly kind: "settings"; readonly tab: "accounts" | "appearance" | "notifications" }
	| { readonly kind: "workspaceSettings"; readonly workspaceId: string };

export type Attention = "approval" | "done" | "failed";

// A message the daemon refused. It stays apart from the draft, so typing on or switching chats never loses it.
export interface FailedSend {
	readonly id: number;
	readonly text: string;
	readonly images: ReadonlyArray<DraftImage>;
	readonly error: string;
}

export interface AppState {
	readonly connection:
		| { readonly status: "connecting" | "ready" | "reconnecting" }
		| { readonly status: "failed"; readonly message: string };
	// One record per entity, keyed by id. Lists are derived where they are shown.
	readonly projects: Readonly<Record<string, Project>>;
	readonly workspaces: Readonly<Record<string, Workspace>>;
	readonly sessions: Readonly<Record<string, AgentSession>>;
	readonly agents: ReadonlyArray<AgentInfo>;
	// Chats closed as tabs. They stay in the sidebar and reopen as a tab when picked.
	readonly closedTabs: ReadonlySet<string>;
	readonly attention: Readonly<Record<string, Attention>>;
	// Keyed by session id, oldest first.
	readonly failedSends: Readonly<Record<string, ReadonlyArray<FailedSend>>>;
	// Keyed by workspace id: how many reverts rewrote its files, so views of them reload.
	readonly reverts: Readonly<Record<string, number>>;
	readonly selectedWorkspaceId: string | null;
	readonly selectedSessionId: string | null;
	// Only the visible chat's events are in memory.
	readonly chat: ChatState | null;
	readonly panel: { readonly open: boolean; readonly tab: PanelTab };
	readonly dialog: DialogState | null;
	readonly settings: Settings;
}

let state: AppState = {
	connection: { status: "connecting" },
	projects: {},
	workspaces: {},
	sessions: {},
	agents: [],
	closedTabs: new Set(),
	attention: {},
	failedSends: {},
	reverts: {},
	selectedWorkspaceId: null,
	selectedSessionId: null,
	chat: null,
	panel: { open: true, tab: "diff" },
	dialog: null,
	settings: defaultSettings,
};

const listeners = new Set<() => void>();

export const getState = () => state;

const setState = (update: (current: AppState) => Partial<AppState>) => {
	state = { ...state, ...update(state) };
	for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

// Selectors must return a value already in the state, or a primitive, so React can skip unchanged renders.
export const useAppState = <A>(select: (current: AppState) => A): A =>
	useSyncExternalStore(
		subscribe,
		() => select(state),
		() => select(state),
	);

const byId = <A extends { readonly id: string }>(items: ReadonlyArray<A>) =>
	Object.fromEntries(items.map((item) => [item.id, item]));

const without = <A>(record: Readonly<Record<string, A>>, key: string) => {
	const { [key]: _, ...rest } = record;
	return rest;
};

export const toast = (text: string, tone: "error" | "info" = "error") =>
	tone === "error" ? showToast.error(text) : showToast(text);

// Runs a daemon call and shows its error as a toast. Returns null when it failed.
const attempt = <A>(run: () => Promise<A>): Promise<A | null> =>
	run().catch((error: unknown) => {
		toast(errorMessage(error));
		return null;
	});

// Data

const LAST_WORKSPACE_KEY = "octopus.lastWorkspace";

// Without storage the app opens the first workspace next time, which is fine.
const rememberWorkspace = (workspaceId: string) => writeStored(LAST_WORKSPACE_KEY, workspaceId);

export const refreshAgents = async () => {
	const agents = await attempt(() => callDaemon((daemon) => daemon.listAgents()));
	if (agents !== null) setState(() => ({ agents }));
};

// The lists replace what was held, so a reload after a reconnect also drops what was deleted meanwhile.
const loadProjects = async () => {
	const projects = await callDaemon((daemon) => daemon.listProjects());
	const workspaces = (
		await Promise.all(
			projects.map((project) => callDaemon((daemon) => daemon.listWorkspaces({ projectId: project.id }))),
		)
	).flat();
	const sessions = (
		await Promise.all(
			workspaces
				.filter((workspace) => workspace.status === "active")
				.map((workspace) => callDaemon((daemon) => daemon.listSessions({ workspaceId: workspace.id }))),
		)
	).flat();
	const sessionIds = new Set(sessions.map((session) => session.id));
	const kept = <A>(record: Readonly<Record<string, A>>) =>
		Object.fromEntries(Object.entries(record).filter(([sessionId]) => sessionIds.has(sessionId)));
	const selectionGone =
		(state.selectedWorkspaceId !== null &&
			!workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId)) ||
		(state.selectedSessionId !== null && !sessionIds.has(state.selectedSessionId));
	setState((current) => ({
		projects: byId(projects),
		workspaces: byId(workspaces),
		sessions: byId(sessions),
		attention: kept(current.attention),
		...(selectionGone ? { selectedWorkspaceId: null, selectedSessionId: null } : {}),
	}));
	if (selectionGone) closeChat();
};

export const boot = async () => {
	const settings = loadSettings();
	applyFontSize(settings);
	setState(() => ({ settings }));
	const loaded = await loadProjects().then(
		() => {
			setState(() => ({ connection: { status: "ready" } }));
			return true;
		},
		(error: unknown) => {
			setState(() => ({ connection: { status: "failed", message: errorMessage(error) } }));
			return false;
		},
	);
	if (!loaded) return;
	// Checking the agents starts their CLIs and reads the keychain, so it never holds up files, terminals or history.
	void refreshAgents();
	watchSessions();
	watchAgentLogins();
	const remembered = readStored(LAST_WORKSPACE_KEY);
	const active = Object.values(state.workspaces).filter((workspace) => workspace.status === "active");
	const start = active.find((workspace) => workspace.id === remembered) ?? active[0];
	if (start !== undefined) selectWorkspace(start.id);
};

// Only a dropped socket is worth retrying. A daemon error would fail the same way again.
export const isConnectionDrop = (error: unknown) => errorTag(error) === "RpcClientError";

// Exponential from half a second, capped at 30 s. The jitter keeps windows from retrying in lockstep.
export const reconnectDelay = (attempt: number, random: () => number = Math.random) =>
	Math.min(30_000, 500 * 2 ** attempt) * (0.5 + random() / 2);

// One toast for the whole outage. Sonner replaces a toast that has the same id.
const CONNECTION_TOAST = "daemon-connection";

// Session changes from every workspace. They drive status dots, tab badges and notifications.
const watchSessions = () => {
	followDaemon((daemon) => daemon.watchSessions(), {
		onItem: (session) => {
			const before = state.sessions[session.id];
			// The watch opens with a snapshot that can overlap changes it also sends, and the lists loaded at
			// boot can be newer than either. Never step a session back to an older state.
			if (before !== undefined && session.updatedAt < before.updatedAt) return;
			setState((current) => ({ sessions: { ...current.sessions, [session.id]: session } }));
			if (before !== undefined) noticeChange(before, session);
		},
		onEnd: (error) => {
			// The daemon ended the watch itself, which only happens when it shuts down.
			if (error === null) return;
			if (!isConnectionDrop(error)) {
				toast("Chat status stopped updating. Restart Octopus to see it again.");
				return;
			}
			setState(() => ({ connection: { status: "reconnecting" } }));
			showToast.loading("Lost the connection to the daemon. Reconnecting.", {
				id: CONNECTION_TOAST,
				duration: Number.POSITIVE_INFINITY,
			});
			reconnect(0);
		},
	});
};

// A sign-in finishes in the browser, so the account list refreshes when the agent says it ended.
// A dropped socket ends this watch too, and the reconnect in watchSessions starts it again.
const watchAgentLogins = () => {
	followDaemon((daemon) => daemon.watchAgentLogins(), {
		onItem: ({ agent, success }) => {
			const name = agent === "claude" ? "Claude Code" : "Codex";
			if (success) toast(`Signed in to ${name}.`, "info");
			else toast(`The ${name} sign-in did not finish. Try again.`);
			void refreshAgents();
		},
		onEnd: (error) => {
			// The daemon ended it by shutting down, or the socket dropped and watchSessions reconnects both.
			if (error === null || isConnectionDrop(error)) return;
			toast("Sign-in results stopped arriving. Restart Octopus to see them again.");
		},
	});
};

// Reloads the lists the watch kept fresh, then watches again. The reload is what proves the daemon is back.
const reconnect = (attempt: number) => {
	setTimeout(() => {
		loadProjects().then(
			() => {
				setState(() => ({ connection: { status: "ready" } }));
				showToast.success("Reconnected to the daemon.", { id: CONNECTION_TOAST, duration: 4000 });
				watchSessions();
				watchAgentLogins();
			},
			(error: unknown) => {
				if (isConnectionDrop(error)) {
					reconnect(attempt + 1);
					return;
				}
				setState(() => ({ connection: { status: "failed", message: errorMessage(error) } }));
				showToast.dismiss(CONNECTION_TOAST);
			},
		);
	}, reconnectDelay(attempt));
};

const noticeChange = (before: AgentSession, after: AgentSession) => {
	const attention: Attention | null =
		after.status === "awaitingApproval" && before.status !== "awaitingApproval"
			? "approval"
			: before.status === "running" && after.status === "idle"
				? "done"
				: after.status === "failed" && before.status !== "failed"
					? "failed"
					: null;
	if (attention === null) return;
	const visible = state.selectedSessionId === after.id && document.visibilityState === "visible";
	if (!visible) setState((current) => ({ attention: { ...current.attention, [after.id]: attention } }));
	if (document.hasFocus()) return;
	lastNotified = after.id;
	const { settings } = state;
	const title = sessionTitle(after);
	const body =
		attention === "approval"
			? "The agent needs your approval."
			: attention === "done"
				? "The turn finished."
				: "The turn failed.";
	if (settings.desktopNotifications) void showNotification(title, body);
	if (settings.sound) playChime();
};

// The desktop notification cannot report a click, so the chat that notified last opens when the window comes back.
let lastNotified: string | null = null;

export const onWindowFocus = () => {
	const sessionId = lastNotified;
	lastNotified = null;
	if (sessionId !== null && state.sessions[sessionId] !== undefined) selectSession(sessionId);
};

export const sessionTitle = (session: AgentSession) =>
	session.title ?? `${session.agent === "claude" ? "Claude" : "Codex"} chat`;

// Projects

export const addProject = async (path: string) => {
	const project = await callDaemon((daemon) => daemon.addProject({ path }));
	setState((current) => ({ projects: { ...current.projects, [project.id]: project } }));
	return project;
};

export const createProject = async (parentPath: string, name: string) => {
	const project = await callDaemon((daemon) => daemon.createProject({ parentPath, name }));
	setState((current) => ({ projects: { ...current.projects, [project.id]: project } }));
	return project;
};

// The daemon refuses while the project has active workspaces, so only archived ones and their chats remain here.
export const removeProject = async (projectId: string) => {
	const done = await attempt(() => callDaemon((daemon) => daemon.removeProject({ projectId })));
	if (done === null) return false;
	const removed = new Set(
		Object.values(state.workspaces)
			.filter((workspace) => workspace.projectId === projectId)
			.map((workspace) => workspace.id),
	);
	const kept = <A>(record: Readonly<Record<string, A>>, workspaceOf: (key: string) => string | undefined) =>
		Object.fromEntries(Object.entries(record).filter(([key]) => !removed.has(workspaceOf(key) ?? "")));
	const sessionWorkspace = (sessionId: string) => state.sessions[sessionId]?.workspaceId;
	const selectionRemoved = state.selectedWorkspaceId !== null && removed.has(state.selectedWorkspaceId);
	for (const [sessionId, sends] of Object.entries(state.failedSends)) {
		if (removed.has(sessionWorkspace(sessionId) ?? "")) releaseImages(sends.flatMap((send) => send.images));
	}
	releaseDrafts(Object.keys(state.sessions).filter((sessionId) => removed.has(sessionWorkspace(sessionId) ?? "")));
	setState((current) => ({
		projects: without(current.projects, projectId),
		workspaces: kept(current.workspaces, (workspaceId) => workspaceId),
		sessions: kept(current.sessions, sessionWorkspace),
		attention: kept(current.attention, sessionWorkspace),
		failedSends: kept(current.failedSends, sessionWorkspace),
		...(selectionRemoved ? { selectedWorkspaceId: null, selectedSessionId: null } : {}),
	}));
	if (selectionRemoved) closeChat();
	return true;
};

export const setProjectTrust = async (projectId: string, trusted: boolean) => {
	const before = state.projects[projectId];
	if (before === undefined) return;
	// Optimistic: the switch moves at once and moves back if the daemon refuses.
	setState((current) => ({ projects: { ...current.projects, [projectId]: { ...before, trusted } } }));
	const saved = await attempt(() => callDaemon((daemon) => daemon.setProjectTrust({ projectId, trusted })));
	setState((current) => {
		const now = current.projects[projectId];
		if (now === undefined) return {};
		return { projects: { ...current.projects, [projectId]: saved ?? { ...now, trusted: before.trusted } } };
	});
};

export const updateProjectScripts = async (projectId: string, setupScript: string | null, runScript: string | null) => {
	const saved = await callDaemon((daemon) => daemon.updateProjectScripts({ projectId, setupScript, runScript }));
	setState((current) => ({ projects: { ...current.projects, [projectId]: saved } }));
	return saved;
};

// Workspaces

// Creating a chat or workspace takes a moment. If the user picked something else meanwhile, the new one waits in the
// sidebar instead of pulling them back.
const currentSelection = () => `${state.selectedWorkspaceId} ${state.selectedSessionId}`;

export const createWorkspace = async (input: CreateWorkspaceInput) => {
	const selection = currentSelection();
	const workspace = await callDaemon((daemon) => daemon.createWorkspace(input));
	setState((current) => ({ workspaces: { ...current.workspaces, [workspace.id]: workspace } }));
	if (currentSelection() === selection) selectWorkspace(workspace.id);
	return workspace;
};

// Fails with the daemon's error, so the caller can offer to force past unsaved work.
export const archiveWorkspace = async (workspaceId: string, force: boolean) => {
	const archived = await callDaemon((daemon) => daemon.archiveWorkspace({ workspaceId, force }));
	releaseDrafts(
		Object.values(state.sessions)
			.filter((session) => session.workspaceId === workspaceId)
			.map((session) => session.id),
	);
	setState((current) => ({
		workspaces: { ...current.workspaces, [workspaceId]: archived },
		...(current.selectedWorkspaceId === workspaceId ? { selectedWorkspaceId: null, selectedSessionId: null } : {}),
	}));
	if (state.selectedSessionId === null) closeChat();
};

// Brings an archived workspace back and opens it, with the chats it had.
export const unarchiveWorkspace = async (workspaceId: string) => {
	const restored = await attempt(() => callDaemon((daemon) => daemon.unarchiveWorkspace({ workspaceId })));
	if (restored === null) return;
	const sessions = await attempt(() => callDaemon((daemon) => daemon.listSessions({ workspaceId })));
	setState((current) => ({
		workspaces: { ...current.workspaces, [workspaceId]: restored },
		sessions: { ...current.sessions, ...byId(sessions ?? []) },
	}));
	selectWorkspace(workspaceId);
};

export const isUnsavedWorkError = (error: unknown) => errorTag(error) === "WorkspaceHasUnsavedWorkError";

export const updateWorkspace = (workspace: Workspace) =>
	setState((current) => ({ workspaces: { ...current.workspaces, [workspace.id]: workspace } }));

export const workspaceTabs = (
	sessions: AppState["sessions"],
	closedTabs: AppState["closedTabs"],
	workspaceId: string,
) =>
	Object.values(sessions)
		.filter((session) => session.workspaceId === workspaceId && !closedTabs.has(session.id))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

// The chats in a workspace that are working or waiting on the user mid-turn, as one string so it can be selected.
export const workingChats = (
	sessions: ReadonlyArray<Pick<AgentSession, "id" | "workspaceId" | "status">>,
	workspaceId: string,
) =>
	sessions
		.filter(
			(session) =>
				session.workspaceId === workspaceId && (session.status === "running" || session.status === "awaitingApproval"),
		)
		.map((session) => session.id)
		.sort()
		.join(" ");

export const selectWorkspace = (workspaceId: string) => {
	rememberWorkspace(workspaceId);
	const first = workspaceTabs(state.sessions, state.closedTabs, workspaceId)[0];
	setState(() => ({ selectedWorkspaceId: workspaceId }));
	if (first === undefined) {
		setState(() => ({ selectedSessionId: null }));
		closeChat();
	} else {
		selectSession(first.id);
	}
};

// Sessions

export const selectSession = (sessionId: string) => {
	const session = state.sessions[sessionId];
	if (session === undefined) return;
	setState((current) => {
		const closedTabs = new Set(current.closedTabs);
		closedTabs.delete(sessionId);
		return {
			selectedWorkspaceId: session.workspaceId,
			selectedSessionId: sessionId,
			closedTabs,
			attention: without(current.attention, sessionId),
		};
	});
	rememberWorkspace(session.workspaceId);
	if (state.chat?.sessionId !== sessionId) void openChat(sessionId);
};

const defaultChoice = () => {
	const { agents, settings } = state;
	const agent =
		agents.find((info) => info.kind === settings.lastAgent) ??
		agents.find((info) => info.availability.status === "ready") ??
		agents[0];
	if (agent === undefined) return null;
	const model =
		agent.models.find((item) => item.id === settings.lastModel) ??
		agent.models.find((item) => item.id === agent.defaultModel);
	return model === undefined ? null : { agent, model };
};

// Returns the new chat's session id, or null after telling the user why none was created.
export const newChat = async (
	workspaceId = state.selectedWorkspaceId,
	agentKind?: AgentKind,
): Promise<string | null> => {
	if (workspaceId === null) {
		toast("Pick a workspace first.", "info");
		return null;
	}
	const choice = defaultChoice();
	const agent = agentKind === undefined ? choice?.agent : state.agents.find((info) => info.kind === agentKind);
	const model =
		agent === undefined
			? undefined
			: agent.kind === choice?.agent.kind
				? choice.model
				: agent.models.find((item) => item.id === agent.defaultModel);
	if (agent === undefined || model === undefined) {
		toast("No agent is available. Check Settings.", "info");
		return null;
	}
	const selection = currentSelection();
	const session = await attempt(() =>
		callDaemon((daemon) =>
			daemon.createSession({ workspaceId, agent: agent.kind, model: model.id, effort: model.defaultEffort }),
		),
	);
	if (session === null) return null;
	setState((current) => ({ sessions: { ...current.sessions, [session.id]: session } }));
	if (currentSelection() === selection) selectSession(session.id);
	return session.id;
};

// A reply can land after a newer watch update, so it never steps the session back. A refusal undoes only the
// fields the change touched, keeping status updates that arrived meanwhile.
const settleSession = (sessionId: string, saved: AgentSession | null, undo: Partial<AgentSession>) =>
	setState((current) => {
		const now = current.sessions[sessionId];
		if (now === undefined) return {};
		if (saved !== null && saved.updatedAt < now.updatedAt) return {};
		return { sessions: { ...current.sessions, [sessionId]: saved ?? { ...now, ...undo } } };
	});

export const renameSession = async (sessionId: string, title: string) => {
	const before = state.sessions[sessionId];
	if (before === undefined) return;
	setState((current) => ({
		sessions: { ...current.sessions, [sessionId]: { ...before, title: title.trim() || null } },
	}));
	const saved = await attempt(() => callDaemon((daemon) => daemon.renameSession({ sessionId, title })));
	settleSession(sessionId, saved, { title: before.title });
};

// For the composer's suggestions. Null when the call failed, after a toast says why.
export const listSessionCommands = (sessionId: string) =>
	attempt(() => callDaemon((daemon) => daemon.listSessionCommands({ sessionId })));

export const searchFiles = (workspaceId: string, query: string) =>
	attempt(() => callDaemon((daemon) => daemon.searchFiles({ workspaceId, query })));

export const updateSessionSettings = async (
	sessionId: string,
	changes: Partial<Pick<AgentSession, "model" | "effort" | "mode">>,
) => {
	const before = state.sessions[sessionId];
	if (before === undefined) return;
	const { model, effort, mode } = { ...before, ...changes };
	setState((current) => ({
		sessions: { ...current.sessions, [sessionId]: { ...before, model, effort, mode } },
		settings: { ...current.settings, lastAgent: before.agent, lastModel: model },
	}));
	saveSettings(state.settings);
	const saved = await attempt(() =>
		callDaemon((daemon) => daemon.updateSessionSettings({ sessionId, model, effort, mode })),
	);
	settleSession(sessionId, saved, { model: before.model, effort: before.effort, mode: before.mode });
};

// Closing a tab only hides the chat. A running agent keeps working in the background, its chat stays in the
// sidebar, and it notifies when it finishes or needs approval. The composer's stop button is what interrupts it.
export const closeTab = (sessionId: string) => {
	const session = state.sessions[sessionId];
	if (session === undefined) return;
	const remaining = workspaceTabs(state.sessions, state.closedTabs, session.workspaceId).filter(
		(tab) => tab.id !== sessionId,
	);
	setState((current) => ({ closedTabs: new Set([...current.closedTabs, sessionId]) }));
	if (state.selectedSessionId !== sessionId) return;
	const next = remaining.at(-1);
	if (next === undefined) {
		setState(() => ({ selectedSessionId: null }));
		closeChat();
	} else {
		selectSession(next.id);
	}
};

const noFailedSends: ReadonlyArray<FailedSend> = [];

export const failedSendsOf = (current: AppState, sessionId: string) => current.failedSends[sessionId] ?? noFailedSends;

let nextFailedSend = 0;

const setFailedSends = (sessionId: string, update: (sends: ReadonlyArray<FailedSend>) => ReadonlyArray<FailedSend>) =>
	setState((current) => {
		const sends = update(failedSendsOf(current, sessionId));
		return {
			failedSends:
				sends.length === 0 ? without(current.failedSends, sessionId) : { ...current.failedSends, [sessionId]: sends },
		};
	});

const releaseImages = (images: ReadonlyArray<DraftImage>) => {
	for (const image of images) URL.revokeObjectURL(image.previewUrl);
};

// A refused message is kept with the daemon's reason, for the composer to offer Retry and Discard.
// Resolves to whether the daemon took the message.
export const sendMessage = (
	sessionId: string,
	text: string,
	images: ReadonlyArray<DraftImage>,
	steer: boolean,
): Promise<boolean> => {
	const payload = images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
	return callDaemon((daemon) => daemon.sendMessage({ sessionId, text, images: payload, steer })).then(
		() => {
			releaseImages(images);
			return true;
		},
		(error: unknown) => {
			const failed = { id: nextFailedSend++, text, images, error: errorMessage(error) };
			setFailedSends(sessionId, (sends) => [...sends, failed]);
			return false;
		},
	);
};

export const retryFailedSend = (sessionId: string, id: number, steer: boolean) => {
	const failed = failedSendsOf(state, sessionId).find((send) => send.id === id);
	if (failed === undefined) return Promise.resolve(false);
	setFailedSends(sessionId, (sends) => sends.filter((send) => send.id !== id));
	return sendMessage(sessionId, failed.text, failed.images, steer);
};

export const discardFailedSend = (sessionId: string, id: number) => {
	const failed = failedSendsOf(state, sessionId).find((send) => send.id === id);
	if (failed === undefined) return;
	releaseImages(failed.images);
	setFailedSends(sessionId, (sends) => sends.filter((send) => send.id !== id));
};

export const previewRevert = (sessionId: string, messageId: string) =>
	attempt(() => callDaemon((daemon) => daemon.previewRevert({ sessionId, messageId })));

export const revertToMessage = async (sessionId: string, messageId: string) => {
	const undone = await attempt(() => callDaemon((daemon) => daemon.revertToMessage({ sessionId, messageId })));
	if (undone === null) return false;
	toast(undone.length === 1 ? "Reverted 1 file." : `Reverted ${undone.length} files.`, "info");
	const workspaceId = state.sessions[sessionId]?.workspaceId;
	if (workspaceId !== undefined) {
		setState((current) => ({
			reverts: { ...current.reverts, [workspaceId]: (current.reverts[workspaceId] ?? 0) + 1 },
		}));
	}
	return true;
};

export const respondToPlan = (sessionId: string, requestId: string, answer: PlanAnswer) =>
	attempt(() => callDaemon((daemon) => daemon.respondToPlan({ sessionId, requestId, answer })));

export const answerQuestion = (sessionId: string, requestId: string, answers: QuestionAnswers) =>
	attempt(() => callDaemon((daemon) => daemon.answerQuestion({ sessionId, requestId, answers })));

export const interruptSession = (sessionId: string) =>
	attempt(() => callDaemon((daemon) => daemon.interruptSession({ sessionId })));

export const respondToApproval = (sessionId: string, requestId: string, decision: ApprovalDecision) =>
	attempt(() => callDaemon((daemon) => daemon.respondToApproval({ sessionId, requestId, decision })));

// The visible chat

let stopChat: (() => void) | null = null;
let pending: Array<SessionEvent> = [];
let flushScheduled = false;
// Bumped each time a chat stream starts or stops. Interrupting a stream is asynchronous, so a stopped stream can
// still deliver events or end with an error. Checking its generation drops those instead of mixing them into the
// next chat or resubscribing a chat that was closed.
let chatGeneration = 0;

// Deltas can arrive hundreds of times a second. Applying them once per frame keeps typing and scrolling smooth.
const flush = () => {
	flushScheduled = false;
	const events = pending;
	pending = [];
	setState((current) =>
		current.chat === null || events.length === 0 ? {} : { chat: applyEvents(current.chat, events) },
	);
};

// failures counts the drops in a row, so a daemon that stays away is retried less and less often.
const follow = (sessionId: string, afterSequence: number, failures = 0) => {
	stopChat?.();
	const generation = ++chatGeneration;
	const isCurrent = () => generation === chatGeneration;
	let failed = failures;
	const stop = followDaemon((daemon) => daemon.subscribeSession({ sessionId, afterSequence }), {
		onItem: (event) => {
			if (!isCurrent()) return;
			failed = 0;
			pending.push(event);
			if (!flushScheduled) {
				flushScheduled = true;
				requestAnimationFrame(flush);
			}
		},
		onEnd: (error) => {
			if (!isCurrent()) return;
			flush();
			const resume = (failures: number) => {
				if (isCurrent() && state.chat?.sessionId === sessionId) follow(sessionId, state.chat.lastSequence, failures);
			};
			// Too far behind, or the socket dropped: pick up after the last event we hold, without clearing the chat.
			if (errorTag(error) === "ResubscribeRequiredError") resume(0);
			else if (error !== null && errorTag(error) !== "SessionNotFoundError") {
				setTimeout(() => resume(failed + 1), reconnectDelay(failed));
			}
		},
	});
	stopChat = () => {
		if (isCurrent()) chatGeneration++;
		stop();
	};
};

// A long chat opens on its latest events. Older pages load as the user scrolls up.
const HISTORY_PAGE = 200;

const loadHistory = (sessionId: string, beforeSequence: number | null) =>
	callDaemon((daemon) => daemon.loadSessionHistory({ sessionId, beforeSequence, limit: HISTORY_PAGE }));

const openChat = async (sessionId: string) => {
	closeChat();
	setState(() => ({ chat: emptyChat(sessionId) }));
	const generation = chatGeneration;
	const page = await loadHistory(sessionId, null).catch((error: unknown) => {
		toast(errorMessage(error));
		return null;
	});
	if (generation !== chatGeneration) return;
	if (page === null) {
		// Without the latest page the chat still loads, from its first event.
		follow(sessionId, -1);
		return;
	}
	setState((current) => (current.chat === null ? {} : { chat: applyEvents(current.chat, page) }));
	// The subscription reads stored events after the page's last one, so events stored meanwhile are neither
	// lost nor shown twice.
	follow(sessionId, state.chat?.lastSequence ?? -1);
};

// Per chat, so a page still loading for the chat just left does not hold up the one now open.
const loadingOlder = new Set<string>();

export const loadOlderEvents = async () => {
	const chat = state.chat;
	if (chat === null || chat.firstSequence === null || chat.firstSequence <= 0) return;
	const { sessionId, firstSequence } = chat;
	if (loadingOlder.has(sessionId)) return;
	loadingOlder.add(sessionId);
	const page = await attempt(() => loadHistory(sessionId, firstSequence));
	loadingOlder.delete(sessionId);
	if (page === null) return;
	// Only onto the chat it was loaded for. A chat reopened in the meantime starts from another page.
	// An empty page means nothing older is stored, so the chat stops asking.
	setState((current) =>
		current.chat?.sessionId === sessionId && current.chat.firstSequence === firstSequence
			? { chat: page.length === 0 ? { ...current.chat, firstSequence: 0 } : prependEvents(current.chat, page) }
			: {},
	);
};

const closeChat = () => {
	stopChat?.();
	stopChat = null;
	// A history load still under way belongs to the chat being closed.
	chatGeneration++;
	pending = [];
	if (state.chat !== null) setState(() => ({ chat: null }));
};

// Layout and dialogs

export const openDialog = (dialog: DialogState | null) => setState(() => ({ dialog }));

export const setPanel = (panel: Partial<AppState["panel"]>) =>
	setState((current) => ({ panel: { ...current.panel, ...panel } }));

export const updateSettings = (changes: Partial<Settings>) => {
	setState((current) => ({ settings: { ...current.settings, ...changes } }));
	saveSettings(state.settings);
	applyFontSize(state.settings);
};

// Accounts

export const setAgentApiKey = async (agent: AgentKind, apiKey: string) => {
	const saved = await attempt(() =>
		callDaemon((daemon) => daemon.setAgentApiKey({ agent, apiKey: Redacted.make(apiKey) })),
	);
	await refreshAgents();
	return saved !== null;
};

export const removeAgentApiKey = async (agent: AgentKind) => {
	await attempt(() => callDaemon((daemon) => daemon.removeAgentApiKey({ agent })));
	await refreshAgents();
};

export const setAgentAuthMode = async (agent: AgentKind, mode: AgentAuthMode) => {
	await attempt(() => callDaemon((daemon) => daemon.setAgentAuthMode({ agent, mode })));
	await refreshAgents();
};

export const startAgentLogin = (agent: AgentKind) =>
	attempt(() => callDaemon((daemon) => daemon.startAgentLogin({ agent })));

export const submitAgentLoginCode = async (agent: AgentKind, code: string) =>
	(await attempt(() => callDaemon((daemon) => daemon.submitAgentLoginCode({ agent, code: Redacted.make(code) })))) !==
	null;
