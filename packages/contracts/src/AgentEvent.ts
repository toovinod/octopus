import { AgentMode } from "./AgentSession.ts";
import { Schema } from "effect";

// Normalized agent events. The shape follows the Codex app-server protocol, the richer of the two,
// and the Claude adapter maps its SDK messages onto it.

export const ApprovalDecision = Schema.Literals(["allowOnce", "allowForSession", "deny"]);
export type ApprovalDecision = typeof ApprovalDecision.Type;

export const ApprovalOutcome = Schema.Union([ApprovalDecision, Schema.Literal("cancelled")]);
export type ApprovalOutcome = typeof ApprovalOutcome.Type;

// The user's answer to a plan: build it in one of the offered modes, or keep planning with feedback.
export const PlanAnswer = Schema.Union([
	Schema.Struct({ type: Schema.Literal("approve"), mode: AgentMode }),
	Schema.Struct({ type: Schema.Literal("revise"), feedback: Schema.String }),
]);
export type PlanAnswer = typeof PlanAnswer.Type;

// Cancelled when the turn was stopped or the user sent a new message instead of answering.
export const PlanOutcome = Schema.Union([...PlanAnswer.members, Schema.Struct({ type: Schema.Literal("cancelled") })]);
export type PlanOutcome = typeof PlanOutcome.Type;

// A question the agent asks before it goes on, as Claude's AskUserQuestion and Codex's request_user_input do.
export const AgentQuestion = Schema.Struct({
	id: Schema.String,
	header: Schema.String,
	question: Schema.String,
	options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
	multiSelect: Schema.Boolean,
	// The user may type their own answer instead of picking an option.
	allowsOther: Schema.Boolean,
	// The answer is a secret, so it is passed to the agent but never stored.
	secret: Schema.Boolean,
});
export type AgentQuestion = typeof AgentQuestion.Type;

// The picked option labels or typed text, by question id.
export const QuestionAnswers = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type QuestionAnswers = typeof QuestionAnswers.Type;

// Answers to secret questions are left out. Cancelled as for a plan.
export const QuestionOutcome = Schema.Union([
	Schema.Struct({ type: Schema.Literal("answered"), answers: QuestionAnswers }),
	Schema.Struct({ type: Schema.Literal("cancelled") }),
]);
export type QuestionOutcome = typeof QuestionOutcome.Type;

export const FileChange = Schema.Struct({
	path: Schema.String,
	kind: Schema.Literals(["add", "delete", "update"]),
	diff: Schema.String,
});
export type FileChange = typeof FileChange.Type;

export const ToolCall = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("command"),
		command: Schema.String,
		cwd: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("fileChange"),
		changes: Schema.Array(FileChange),
	}),
	Schema.Struct({
		kind: Schema.Literal("mcpCall"),
		server: Schema.String,
		tool: Schema.String,
	}),
	// Tools with no richer shape, such as Claude's Read or WebSearch.
	Schema.Struct({
		kind: Schema.Literal("other"),
		name: Schema.String,
	}),
]);
export type ToolCall = typeof ToolCall.Type;
export type ToolKind = ToolCall["kind"];

export const TurnResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("completed") }),
	Schema.Struct({ status: Schema.Literal("interrupted") }),
	Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
]);
export type TurnResult = typeof TurnResult.Type;

// Set on the text streamed so far, which a subscription sends first. It replaces what the client holds for
// the item instead of adding to it, so a chat opened mid-reply shows all of it.
const SnapshotFlag = Schema.optionalKey(Schema.Literal(true));

export const AgentEvent = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("session.started"),
		nativeSessionId: Schema.String,
	}),
	// The user's own message, stored so history shows it. Images are stored apart and fetched by id.
	Schema.Struct({
		type: Schema.Literal("user.message"),
		itemId: Schema.String,
		text: Schema.String,
		attachments: Schema.Array(Schema.Struct({ id: Schema.String, mediaType: Schema.String })),
	}),
	// Context used by the conversation so far, after each model call.
	Schema.Struct({
		type: Schema.Literal("usage.updated"),
		contextTokens: Schema.Int,
		contextWindow: Schema.NullOr(Schema.Int),
	}),
	// Plan usage limits, when the provider reports them (subscriptions mostly).
	Schema.Struct({
		type: Schema.Literal("rateLimit.updated"),
		window: Schema.String,
		status: Schema.Literals(["allowed", "warning", "rejected"]),
		usedPercent: Schema.NullOr(Schema.Number),
		resetsAt: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("message.delta"),
		itemId: Schema.String,
		text: Schema.String,
		snapshot: SnapshotFlag,
	}),
	Schema.Struct({
		type: Schema.Literal("message.completed"),
		itemId: Schema.String,
		text: Schema.String,
	}),
	// The model's thinking before or between replies. Deltas are live only, like message deltas.
	Schema.Struct({
		type: Schema.Literal("reasoning.delta"),
		itemId: Schema.String,
		text: Schema.String,
		snapshot: SnapshotFlag,
	}),
	Schema.Struct({
		type: Schema.Literal("reasoning.completed"),
		itemId: Schema.String,
		text: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("tool.started"),
		itemId: Schema.String,
		tool: ToolCall,
	}),
	Schema.Struct({
		type: Schema.Literal("tool.completed"),
		itemId: Schema.String,
		tool: ToolCall,
		status: Schema.Literals(["completed", "failed", "declined"]),
		output: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		type: Schema.Literal("approval.requested"),
		requestId: Schema.String,
		itemId: Schema.String,
		kind: Schema.Literals(["command", "fileChange", "mcpCall", "other"]),
		summary: Schema.String,
		reason: Schema.NullOr(Schema.String),
		choices: Schema.Array(ApprovalDecision),
	}),
	Schema.Struct({
		type: Schema.Literal("approval.resolved"),
		requestId: Schema.String,
		outcome: ApprovalOutcome,
	}),
	Schema.Struct({
		type: Schema.Literal("turn.completed"),
		turnId: Schema.String,
		result: TurnResult,
	}),
	// A plan from plan mode, waiting for the user to approve it or ask for changes. choices are the
	// modes the user may build it in.
	Schema.Struct({
		type: Schema.Literal("plan.proposed"),
		requestId: Schema.String,
		itemId: Schema.String,
		text: Schema.String,
		choices: Schema.Array(AgentMode),
	}),
	Schema.Struct({
		type: Schema.Literal("plan.resolved"),
		requestId: Schema.String,
		outcome: PlanOutcome,
	}),
	// Questions the agent waits on before it goes on.
	Schema.Struct({
		type: Schema.Literal("question.asked"),
		requestId: Schema.String,
		itemId: Schema.String,
		questions: Schema.Array(AgentQuestion),
	}),
	Schema.Struct({
		type: Schema.Literal("question.resolved"),
		requestId: Schema.String,
		outcome: QuestionOutcome,
	}),
	// The agent changed its own mode, as Claude does when the user approves a plan.
	Schema.Struct({
		type: Schema.Literal("mode.changed"),
		mode: AgentMode,
	}),
	// Non-fatal problems. A fatal one fails the event stream instead.
	Schema.Struct({
		type: Schema.Literal("error"),
		message: Schema.String,
		willRetry: Schema.Boolean,
	}),
]).pipe(Schema.toTaggedUnion("type"));
export type AgentEvent = typeof AgentEvent.Type;

// Streaming deltas reach live subscribers but are never stored. The completed event is.
export const isLiveOnly = (event: AgentEvent) => event.type === "message.delta" || event.type === "reasoning.delta";
