import {
	AgentCommand,
	AgentAuthMode,
	AgentInfo,
	AgentMode,
	AgentKind,
	AgentLoginResult,
	AttachmentNotFoundError,
	AuthModeNotAllowedError,
	ImageData,
	ImagesNotSupportedError,
	LoginNotPendingError,
	ModeNotAllowedError,
	MAX_IMAGES_PER_MESSAGE,
	AgentSession,
	AgentUnavailableError,
	ApprovalNotFoundError,
	ResubscribeRequiredError,
	SessionBusyError,
	SessionNotFoundError,
} from "./AgentSession.ts";
import { CheckpointChange, CheckpointNotFoundError, WorkspaceAgentsBusyError } from "./Checkpoint.ts";
import { WorkspaceArchivedError, WorkspaceNotFoundError } from "./Workspace.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { ApprovalDecision } from "./AgentEvent.ts";
import { SessionEvent } from "./SessionEvent.ts";
import { GitTimeoutError } from "./Git.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

export class SessionRpcs extends RpcGroup.make(
	Rpc.make("listAgents", {
		success: Schema.Array(AgentInfo),
		error: DaemonInternalError,
	}),
	// The key travels only over the local socket and is stored in the OS keychain.
	Rpc.make("setAgentApiKey", {
		payload: { agent: AgentKind, apiKey: Schema.Redacted(Schema.String) },
		error: DaemonInternalError,
	}),
	Rpc.make("removeAgentApiKey", {
		payload: { agent: AgentKind },
		error: DaemonInternalError,
	}),
	// Applies to new sessions only. Running sessions keep the credential they started with.
	Rpc.make("setAgentAuthMode", {
		payload: { agent: AgentKind, mode: AgentAuthMode },
		error: Schema.Union([AuthModeNotAllowedError, DaemonInternalError]),
	}),
	// Starts the agent's own sign-in (ChatGPT for Codex, claude.ai for Claude) and returns the URL to open.
	// The agent keeps the tokens. claude also opens the browser itself.
	Rpc.make("startAgentLogin", {
		payload: { agent: AgentKind },
		success: Schema.Struct({ authUrl: Schema.String }),
		error: Schema.Union([AuthModeNotAllowedError, DaemonInternalError]),
	}),
	// The code claude.ai shows when the browser cannot hand the sign-in back to claude by itself.
	Rpc.make("submitAgentLoginCode", {
		payload: { agent: AgentKind, code: Schema.Redacted(Schema.String) },
		error: Schema.Union([LoginNotPendingError, DaemonInternalError]),
	}),
	// How each sign-in from startAgentLogin ended, as it ends, so the client can refresh the agents without asking.
	Rpc.make("watchAgentLogins", {
		success: AgentLoginResult,
		stream: true,
	}),
	// The agent process starts on the first message.
	Rpc.make("createSession", {
		payload: {
			workspaceId: Schema.String,
			agent: AgentKind,
			model: Schema.String,
			effort: Schema.NullOr(Schema.String),
		},
		success: AgentSession,
		error: Schema.Union([WorkspaceNotFoundError, DaemonInternalError]),
	}),
	Rpc.make("listSessions", {
		payload: { workspaceId: Schema.String },
		success: Schema.Array(AgentSession),
		error: DaemonInternalError,
	}),
	Rpc.make("renameSession", {
		payload: { sessionId: Schema.String, title: Schema.String },
		success: AgentSession,
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// Model and effort take effect from the next turn. A mode change reaches a running Claude turn at once.
	Rpc.make("updateSessionSettings", {
		payload: {
			sessionId: Schema.String,
			model: Schema.String,
			effort: Schema.NullOr(Schema.String),
			mode: AgentMode,
		},
		success: AgentSession,
		error: Schema.Union([SessionNotFoundError, ModeNotAllowedError, DaemonInternalError]),
	}),
	// steer sends the text into the running turn when the agent supports it, otherwise it queues.
	Rpc.make("sendMessage", {
		payload: {
			sessionId: Schema.String,
			text: Schema.String,
			images: Schema.Array(ImageData).check(Schema.isMaxLength(MAX_IMAGES_PER_MESSAGE)),
			steer: Schema.Boolean,
		},
		error: Schema.Union([
			SessionNotFoundError,
			SessionBusyError,
			AgentUnavailableError,
			ImagesNotSupportedError,
			WorkspaceArchivedError,
			DaemonInternalError,
		]),
	}),
	// What reverting to the checkpoint saved before a message would undo.
	Rpc.make("previewRevert", {
		payload: { sessionId: Schema.String, messageId: Schema.String },
		success: Schema.Array(CheckpointChange),
		error: Schema.Union([
			SessionNotFoundError,
			CheckpointNotFoundError,
			WorkspaceArchivedError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	// Puts the workspace's files back as they were just before the message was sent. Returns what it undid.
	Rpc.make("revertToMessage", {
		payload: { sessionId: Schema.String, messageId: Schema.String },
		success: Schema.Array(CheckpointChange),
		error: Schema.Union([
			SessionNotFoundError,
			CheckpointNotFoundError,
			WorkspaceAgentsBusyError,
			WorkspaceArchivedError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	// Starts the agent if it is not running, since only a running agent knows its commands.
	Rpc.make("listSessionCommands", {
		payload: { sessionId: Schema.String },
		success: Schema.Array(AgentCommand),
		error: Schema.Union([SessionNotFoundError, AgentUnavailableError, WorkspaceArchivedError, DaemonInternalError]),
	}),
	Rpc.make("getAttachment", {
		payload: { sessionId: Schema.String, attachmentId: Schema.String },
		success: ImageData,
		error: Schema.Union([SessionNotFoundError, AttachmentNotFoundError, DaemonInternalError]),
	}),
	Rpc.make("respondToApproval", {
		payload: { sessionId: Schema.String, requestId: Schema.String, decision: ApprovalDecision },
		error: Schema.Union([SessionNotFoundError, ApprovalNotFoundError, DaemonInternalError]),
	}),
	// Stops the running turn and keeps the agent process.
	Rpc.make("interruptSession", {
		payload: { sessionId: Schema.String },
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// Ends the agent process. The next message resumes through the native session id.
	Rpc.make("stopSession", {
		payload: { sessionId: Schema.String },
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// Up to limit stored events before beforeSequence, oldest first. null reads the latest page. A chat opens on
	// that page, subscribes after its last event, and loads older pages as the user scrolls up.
	Rpc.make("loadSessionHistory", {
		payload: {
			sessionId: Schema.String,
			beforeSequence: Schema.NullOr(Schema.Int),
			limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
		},
		success: Schema.Array(SessionEvent),
		error: Schema.Union([SessionNotFoundError, DaemonInternalError]),
	}),
	// Stored events after afterSequence, then live events. -1 starts from the beginning.
	Rpc.make("subscribeSession", {
		payload: { sessionId: Schema.String, afterSequence: Schema.Int },
		success: SessionEvent,
		error: Schema.Union([SessionNotFoundError, ResubscribeRequiredError, DaemonInternalError]),
		stream: true,
	}),
	// Every session of the active workspaces as it is now, then every change (status, title, native id) across
	// all workspaces. The snapshot is read after the watch starts, so a change can come twice: keep the newest
	// updatedAt.
	Rpc.make("watchSessions", {
		success: AgentSession,
		error: DaemonInternalError,
		stream: true,
	}),
) {}
