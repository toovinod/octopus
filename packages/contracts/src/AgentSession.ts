import { Schema } from "effect";

export const AgentKind = Schema.Literals(["claude", "codex"]);
export type AgentKind = typeof AgentKind.Type;

export const AgentAuthMode = Schema.Literals(["subscription", "apiKey"]);
export type AgentAuthMode = typeof AgentAuthMode.Type;

// How much the agent may do without asking, from least to most. Each agent offers its own subset
// (AgentCapabilities.modes) and maps it onto its own permission settings.
export const AgentMode = Schema.Literals(["readOnly", "plan", "ask", "acceptEdits", "auto", "fullAccess"]);
export type AgentMode = typeof AgentMode.Type;

// Agent sessions are not jobs, so they keep their own union.
export const AgentSessionStatus = Schema.Literals(["idle", "running", "awaitingApproval", "interrupted", "failed"]);
export type AgentSessionStatus = typeof AgentSessionStatus.Type;

export class AgentSession extends Schema.Class<AgentSession>("AgentSession")({
	id: Schema.String,
	workspaceId: Schema.String,
	agent: AgentKind,
	model: Schema.String,
	nativeSessionId: Schema.NullOr(Schema.String),
	authMode: AgentAuthMode,
	mode: AgentMode,
	// Effort names differ per agent and model, so they come from AgentModel.efforts.
	effort: Schema.NullOr(Schema.String),
	status: AgentSessionStatus,
	title: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
}) {}

export const AgentModel = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	description: Schema.String,
	efforts: Schema.Array(Schema.String),
	defaultEffort: Schema.NullOr(Schema.String),
	contextWindow: Schema.NullOr(Schema.Int),
	supportsImages: Schema.Boolean,
});
export type AgentModel = typeof AgentModel.Type;

export const AgentCapabilities = Schema.Struct({
	resume: Schema.Boolean,
	interrupt: Schema.Boolean,
	fileChangeApprovals: Schema.Boolean,
	mcpApprovals: Schema.Boolean,
	steerWhileRunning: Schema.Boolean,
	// The modes the user may pick, the default first.
	modes: Schema.Array(AgentMode),
});
export type AgentCapabilities = typeof AgentCapabilities.Type;

export const AgentAvailability = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), account: Schema.NullOr(Schema.String) }),
	Schema.Struct({ status: Schema.Literal("needsApiKey") }),
	Schema.Struct({ status: Schema.Literal("loggedOut") }),
	Schema.Struct({ status: Schema.Literal("notInstalled") }),
	Schema.Struct({ status: Schema.Literal("versionMismatch"), expected: Schema.String, actual: Schema.String }),
	Schema.Struct({ status: Schema.Literal("unknown"), message: Schema.String }),
]);
export type AgentAvailability = typeof AgentAvailability.Type;

// How an agent's own sign-in ended. Why one failed stays in the daemon's logs.
export const AgentLoginResult = Schema.Struct({ agent: AgentKind, success: Schema.Boolean });
export type AgentLoginResult = typeof AgentLoginResult.Type;

export class AgentInfo extends Schema.Class<AgentInfo>("AgentInfo")({
	kind: AgentKind,
	availability: AgentAvailability,
	capabilities: AgentCapabilities,
	// The modes the user may pick.
	authModes: Schema.Array(AgentAuthMode),
	authMode: AgentAuthMode,
	models: Schema.Array(AgentModel),
	defaultModel: Schema.String,
}) {}

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()("SessionNotFoundError", {
	sessionId: Schema.String,
}) {
	override get message() {
		return "This chat no longer exists. Refresh the chat list.";
	}
}

// Retryable: a turn is running and the message queue is full.
export class SessionBusyError extends Schema.TaggedError<SessionBusyError>()("SessionBusyError", {
	queued: Schema.Int,
}) {
	override get message() {
		return `The agent is busy and ${this.queued} message(s) are already queued. Wait for the turn to finish.`;
	}
}

export class ApprovalNotFoundError extends Schema.TaggedError<ApprovalNotFoundError>()("ApprovalNotFoundError", {
	requestId: Schema.String,
}) {
	override get message() {
		return "This approval request was already answered or has expired.";
	}
}

export class AgentUnavailableError extends Schema.TaggedError<AgentUnavailableError>()("AgentUnavailableError", {
	agent: AgentKind,
	availability: AgentAvailability,
}) {
	override get message() {
		const name = this.agent === "claude" ? "Claude Code" : "Codex";
		switch (this.availability.status) {
			case "needsApiKey":
				return `${name} needs an API key. Add one in Settings.`;
			case "loggedOut":
				return `${name} is not signed in. Sign in with its CLI, then try again.`;
			case "notInstalled":
				return `${name} is not installed. Install it, then try again.`;
			case "versionMismatch":
				return `${name} ${this.availability.actual} is installed, but Octopus needs ${this.availability.expected} or newer.`;
			case "unknown":
				return `${name} could not start: ${this.availability.message}`;
		}
		return `${name} could not start. Try again.`;
	}
}

// The subscriber fell too far behind the live stream. Subscribe again from lastSequence.
export class ResubscribeRequiredError extends Schema.TaggedError<ResubscribeRequiredError>()(
	"ResubscribeRequiredError",
	{ lastSequence: Schema.Int },
) {
	override get message() {
		return "The chat fell behind and is reloading.";
	}
}

export const ImageMediaType = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageMediaType = typeof ImageMediaType.Type;

// 5 MB of image data as base64.
export const MAX_IMAGE_BASE64_LENGTH = 7_000_000;
export const MAX_IMAGES_PER_MESSAGE = 10;

export const ImageData = Schema.Struct({
	mediaType: ImageMediaType,
	base64: Schema.String.check(Schema.isMaxLength(MAX_IMAGE_BASE64_LENGTH)),
});
export type ImageData = typeof ImageData.Type;

export class AttachmentNotFoundError extends Schema.TaggedError<AttachmentNotFoundError>()("AttachmentNotFoundError", {
	attachmentId: Schema.String,
}) {
	override get message() {
		return "This image is no longer available.";
	}
}

export class ImagesNotSupportedError extends Schema.TaggedError<ImagesNotSupportedError>()("ImagesNotSupportedError", {
	model: Schema.String,
}) {
	override get message() {
		return `${this.model} cannot read images. Pick another model or send text only.`;
	}
}

export class AuthModeNotAllowedError extends Schema.TaggedError<AuthModeNotAllowedError>()("AuthModeNotAllowedError", {
	agent: AgentKind,
	mode: AgentAuthMode,
}) {
	override get message() {
		const name = this.agent === "claude" ? "Claude Code" : "Codex";
		return `${name} cannot use ${this.mode} sign-in here.`;
	}
}

// Full access runs commands and edits without asking, so a project's own files must not be able to start it.
const modeRefusals = {
	notOffered: "This agent does not offer that mode.",
	untrustedProject: "Full access runs commands without asking. Trust the project first, then choose it again.",
	fork: "Full access is off for a pull request from a fork, since anyone can write its code. Pick another mode.",
} as const;

export class ModeNotAllowedError extends Schema.TaggedError<ModeNotAllowedError>()("ModeNotAllowedError", {
	agent: AgentKind,
	mode: AgentMode,
	reason: Schema.Literals(["notOffered", "untrustedProject", "fork"]),
}) {
	override get message() {
		return modeRefusals[this.reason];
	}
}

// A sign-in code arrived with no sign-in waiting for one: it finished, timed out or was never started.
export class LoginNotPendingError extends Schema.TaggedError<LoginNotPendingError>()("LoginNotPendingError", {
	agent: AgentKind,
}) {
	override get message() {
		return "No sign-in is waiting for a code. Start the sign-in again.";
	}
}
