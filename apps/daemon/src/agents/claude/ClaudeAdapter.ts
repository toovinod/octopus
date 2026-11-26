import {
	type AgentAdapter,
	AgentAuthError,
	type AgentError,
	type AgentAuthStatus,
	type AgentModels,
	AgentNotInstalledError,
	AgentProcessError,
	AgentProtocolError,
	type StartSessionInput,
	type UserMessage,
} from "../AgentAdapter.ts";
import {
	Config,
	Context,
	Deferred,
	Effect,
	Exit,
	FiberHandle,
	FileSystem,
	Layer,
	Option,
	Predicate,
	PubSub,
	Queue,
	Redacted,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect";
import type {
	CanUseTool,
	Options,
	PermissionResult,
	PermissionMode,
	PermissionUpdate,
	SDKUserMessage,
	SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
	type AgentCapabilities,
	type AgentMode,
	type AgentModel,
	LoginNotPendingError,
} from "@repo/contracts/AgentSession";
import type {
	ApprovalDecision,
	ApprovalOutcome,
	QuestionOutcome,
	PlanOutcome,
	ToolCall,
} from "@repo/contracts/AgentEvent";
import { BashInput, ClaudeAuthStatus, ClaudeMessage, FileInput } from "./claudeMessages.ts";
import { type AgentSession, makeAgentSession } from "../makeAgentSession.ts";
import { stopProcessGroup } from "../../processes/stopProcessGroup.ts";
import { ProcessRegistry } from "../../processes/ProcessRegistry.ts";
import { ClaudeQuery, type ClaudeQueryRun } from "./ClaudeQuery.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { spawnTerminal } from "../../terminals/spawnTerminal.ts";
import { spawnInProcessGroup } from "./spawnInProcessGroup.ts";
import { epochSecondsToIso } from "../epochSecondsToIso.ts";
import { isAuthFailureText } from "../isAuthFailureText.ts";
import { keepOutputTail } from "../keepOutputTail.ts";
import { toAgentError } from "../toAgentError.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Octopus runs the user's own `claude`, found on PATH unless this names another one. Inside a
// `bun build --compile` binary the SDK cannot find the CLI it bundles, and the user's install
// is also the one their login belongs to.
export const ClaudeAdapterConfig = Context.Reference<{
	readonly executable: string;
}>("octopus/daemon/agents/claude/ClaudeAdapterConfig", {
	defaultValue: () => ({ executable: "claude" }),
});

const capabilities: AgentCapabilities = {
	resume: true,
	interrupt: true,
	fileChangeApprovals: true,
	mcpApprovals: true,
	// The SDK folds a message sent mid-turn into the running turn.
	steerWhileRunning: true,
	modes: ["ask", "acceptEdits", "plan", "auto", "fullAccess"],
};

// Claude has no read-only mode of its own. Plan is the closest, but readOnly is never offered.
const permissionModes = {
	readOnly: "plan",
	plan: "plan",
	ask: "default",
	acceptEdits: "acceptEdits",
	auto: "auto",
	fullAccess: "bypassPermissions",
} as const satisfies Record<AgentMode, PermissionMode>;

// dontAsk denies whatever is not allowed already. Octopus never sets it, so it maps to nothing.
const fromPermissionMode = (mode: string): Option.Option<AgentMode> => {
	switch (mode) {
		case "default":
			return Option.some("ask");
		case "acceptEdits":
		case "plan":
		case "auto":
			return Option.some(mode);
		case "bypassPermissions":
			return Option.some("fullAccess");
		default:
			return Option.none();
	}
};

// supportedModels() needs a running query, so the list is fixed here. The efforts are the SDK's
// EffortLevel values, and the context window is only known from a turn's usage.
const ClaudeEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
const decodeEffort = (effort: string | null) =>
	effort === null ? Option.none() : Schema.decodeUnknownOption(ClaudeEffort)(effort);

const claudeModel = (id: string, label: string): AgentModel => ({
	id,
	label,
	description: "",
	efforts: ClaudeEffort.literals,
	defaultEffort: null,
	contextWindow: null,
	supportsImages: true,
});

const models: AgentModels = {
	models: [
		claudeModel("claude-opus-5-5", "Claude Opus 5.5"),
		claudeModel("claude-sonnet-5-5", "Claude Sonnet 5.5"),
		claudeModel("claude-haiku-5-5", "Claude Haiku 5.5"),
		claudeModel("claude-fable-5-2", "Claude Fable 5.2"),
	],
	defaultModel: "claude-opus-5-5",
};

// What would make claude bill the API instead of the subscription, bill another key than the one stored for
// Octopus, or send its requests elsewhere: a key or token, another API host, or a cloud provider.
// CLAUDE_CODE_OAUTH_TOKEN stays: it is a subscription token from `claude setup-token`.
const credentialEnv = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_ANTHROPIC_AWS",
	"CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_USE_GATEWAY",
] as const;
const credentialNames = new Set<string>(credentialEnv);
const unsetCredentials = Object.fromEntries(credentialEnv.map((name) => [name, undefined]));
const withoutCredentials = (env: SpawnOptions["env"]): SpawnOptions["env"] =>
	Object.fromEntries(Object.entries(env).filter(([name]) => !credentialNames.has(name)));

// claude also takes these from the env block of its settings files, and a key from their apiKeyHelper. Flag settings
// outrank every settings file, and empty values turn them off, but they never override claude's own environment
// (checked with claude 2.1.332), so the environment is cleaned as well. Claude hands the env block on to the commands
// its Bash tool runs, where an empty value is not the same as none (dotenv skips a set variable, and an SDK takes an
// empty base URL as one), so only what a settings file sets is emptied.
const blankSettings = (names: Iterable<string>, apiKeyHelper: boolean) => ({
	...(apiKeyHelper ? { apiKeyHelper: "" } : {}),
	env: Object.fromEntries([...names].map((name) => [name, ""])),
});

const ClaudeSettingsFile = Schema.fromJsonString(
	Schema.Struct({
		env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
		apiKeyHelper: Schema.optional(Schema.Unknown),
	}),
);

// claude prints the sign-in link as an OSC 8 hyperlink and as text. Both hold the same URL, and
// requiring the character after it keeps a link split across two reads from matching early.
const loginUrlPattern = /https:\/\/[\w.-]+\/oauth\/authorize\?[\w\-.~%&=+/:]+(?=[^\w\-.~%&=+/:])/;
const findLoginUrl = (printed: string) => loginUrlPattern.exec(printed)?.[0] ?? null;

// claude waits for the browser, or a pasted code, about as long as Codex does.
const LOGIN_TIMEOUT = "10 minutes";
const LOGIN_LINK_TIMEOUT = "30 seconds";

const fileTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

const toToolCall = (name: string, input: unknown): ToolCall => {
	if (name === "Bash") {
		const bash = Schema.decodeUnknownOption(BashInput)(input);
		if (Option.isSome(bash)) {
			return { kind: "command", command: bash.value.command, cwd: null };
		}
	}
	if (fileTools.has(name)) {
		const file = Schema.decodeUnknownOption(FileInput)(input);
		if (Option.isSome(file)) {
			const path = "file_path" in file.value ? file.value.file_path : file.value.notebook_path;
			// The SDK sends edit arguments, not a diff, so the diff stays empty.
			return {
				kind: "fileChange",
				changes: [{ path, kind: name === "Write" ? "add" : "update", diff: "" }],
			};
		}
	}
	// MCP tools are named mcp__<server>__<tool>.
	const [prefix, server, ...tool] = name.split("__");
	if (prefix === "mcp" && server !== undefined && tool.length > 0) {
		return { kind: "mcpCall", server, tool: tool.join("__") };
	}
	return { kind: "other", name };
};

// What claude answers, before it reads any message, to a resume of a session whose transcript is gone.
const isMissingSession = (message: ClaudeMessage) =>
	"errors" in message &&
	(message.errors ?? []).some((error) => error.startsWith("No conversation found with session ID"));

// Claude calls this tool to leave plan mode. Octopus shows the plan as its own card, not as a tool call.
const EXIT_PLAN_MODE = "ExitPlanMode";

// Claude calls this tool to ask the user questions. Octopus shows them as their own card too.
const ASK_USER_QUESTION = "AskUserQuestion";

const AskUserQuestionInput = Schema.Struct({
	questions: Schema.Array(
		Schema.Struct({
			question: Schema.String,
			header: Schema.String,
			options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
			multiSelect: Schema.Boolean,
		}),
	),
});
const decodeQuestions = Schema.decodeUnknownOption(AskUserQuestionInput);

// Claude keys answers by the question's text and joins several picked labels with commas, as its own prompt does.
// It always takes a typed answer in place of the options.
const toQuestionPermissionResult = (
	outcome: QuestionOutcome,
	input: Record<string, unknown>,
	questions: (typeof AskUserQuestionInput.Type)["questions"],
): PermissionResult => {
	if (outcome.type === "cancelled") return { behavior: "deny", message: "The user did not answer the questions." };
	const answers = Object.fromEntries(
		questions.map((question, index) => [question.question, (outcome.answers[`q${index}`] ?? []).join(", ")]),
	);
	return { behavior: "allow", updatedInput: { ...input, answers } };
};

// The modes a plan may be built in, in the order Claude Code offers them. Full access needs a trusted project.
const buildModes = (trusted: boolean): ReadonlyArray<AgentMode> =>
	(["auto", "acceptEdits", "ask", "fullAccess"] as const).filter(
		(mode) => capabilities.modes.includes(mode) && (trusted || mode !== "fullAccess"),
	);

// Claude Code reads the plan from its plan file and passes it in the tool's input.
const planText = (input: Record<string, unknown>) => (Predicate.isString(input.plan) ? input.plan : "");

// Answers ExitPlanMode as Claude Code's own plan prompt does: approving switches the mode for the session,
// and a refusal with feedback keeps Claude planning.
const toPlanPermissionResult = (outcome: PlanOutcome, input: Record<string, unknown>): PermissionResult => {
	switch (outcome.type) {
		case "approve":
			return {
				behavior: "allow",
				updatedInput: input,
				updatedPermissions: [{ type: "setMode", mode: permissionModes[outcome.mode], destination: "session" }],
			};
		case "revise":
			return {
				behavior: "deny",
				message: outcome.feedback.trim() === "" ? "The user wants to keep planning." : outcome.feedback,
			};
		case "cancelled":
			return { behavior: "deny", message: "The user did not approve the plan." };
	}
};

// "Allow for session" may only add allow rules for this session. Suggestions that switch
// the permission mode, add directories, replace rules or write a settings file are dropped.
export const sessionAllowRules = (suggestions: ReadonlyArray<PermissionUpdate>): ReadonlyArray<PermissionUpdate> =>
	suggestions.flatMap((suggestion) =>
		suggestion.type === "addRules" && suggestion.behavior === "allow"
			? [{ ...suggestion, destination: "session" }]
			: [],
	);

const toPermissionResult = (
	outcome: ApprovalOutcome,
	input: Record<string, unknown>,
	suggestions: ReadonlyArray<PermissionUpdate>,
): PermissionResult => {
	switch (outcome) {
		case "allowOnce":
			return { behavior: "allow", updatedInput: input };
		case "allowForSession":
			return {
				behavior: "allow",
				updatedInput: input,
				updatedPermissions: [...suggestions],
			};
		case "deny":
			return { behavior: "deny", message: "The user denied this action." };
		case "cancelled":
			return {
				behavior: "deny",
				message: "The user stopped the turn.",
				interrupt: true,
			};
	}
};

const windowNames: Record<string, string> = {
	five_hour: "5 hours",
	seven_day: "7 days",
	seven_day_opus: "7 days (Opus)",
	seven_day_sonnet: "7 days (Sonnet)",
	seven_day_overage_included: "7 days (with extra usage)",
	overage: "Extra usage",
};

const toolResultText = (
	content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }> | undefined,
) => {
	if (content === undefined) return null;
	if (typeof content === "string") return keepOutputTail(content);
	return keepOutputTail(content.map((part) => ("text" in part ? part.text : "")).join("\n"));
};

// interruptAgain stops a turn claude runs by itself after a Stop, from a steer it still had queued.
const makeMessageHandler = Effect.fnUntraced(function* (session: AgentSession, interruptAgain: Effect.Effect<void>) {
	// Stream deltas and finished blocks share an item id: the message id plus the block index.
	const streamingMessageId = yield* Ref.make("");
	const finishedBlocks = yield* Ref.make({ messageId: "", count: 0 });
	const tools = new Map<string, ToolCall>();
	// ExitPlanMode calls, which show as plan cards instead of tool calls.
	// Tool calls shown as a plan or question card instead.
	const cardTools = new Set<string>();
	const interrupting = yield* Ref.make(false);
	// The uuid of the last message Octopus sent claude.
	const lastSent = yield* Ref.make("");
	// The context after the turn is what its last model call read and wrote.
	const lastUsage = yield* Ref.make(Option.none<{ readonly model: string; readonly contextTokens: number }>());

	const handle = Effect.fnUntraced(function* (message: ClaudeMessage) {
		yield* session.touch;
		// Subagent frames belong to the Task tool call that started them.
		if ("parent_tool_use_id" in message && message.parent_tool_use_id !== null) return;
		switch (message.type) {
			case "system": {
				if ("session_id" in message) {
					return yield* session.setNativeSessionId(message.session_id);
				}
				if (!("permissionMode" in message) || message.permissionMode === undefined) return;
				const mode = fromPermissionMode(message.permissionMode);
				if (Option.isSome(mode)) {
					yield* session.emit({ type: "mode.changed", mode: mode.value });
				}
				return;
			}
			case "stream_event": {
				if (!("event" in message)) return;
				const { event } = message;
				if (event.type === "message_start" && "message" in event) {
					return yield* Ref.set(streamingMessageId, event.message.id);
				}
				if ("delta" in event && "text" in event.delta) {
					const messageId = yield* Ref.get(streamingMessageId);
					return yield* session.emit({
						type: "message.delta",
						itemId: `${messageId}:${event.index}`,
						text: event.delta.text,
					});
				}
				if ("delta" in event && "thinking" in event.delta) {
					const messageId = yield* Ref.get(streamingMessageId);
					return yield* session.emit({
						type: "reasoning.delta",
						itemId: `${messageId}:${event.index}`,
						text: event.delta.thinking,
					});
				}
				return;
			}
			case "assistant": {
				if (!("message" in message) || !("id" in message.message)) return;
				if ("error" in message && message.error === "authentication_failed") {
					return yield* new AgentAuthError({ agent: "claude", cause: message.error });
				}
				const { id, content, model, usage } = message.message;
				if (usage !== undefined) {
					const contextTokens =
						usage.input_tokens +
						(usage.cache_creation_input_tokens ?? 0) +
						(usage.cache_read_input_tokens ?? 0) +
						usage.output_tokens;
					yield* Ref.set(lastUsage, Option.some({ model: model ?? "", contextTokens }));
				}
				const previous = yield* Ref.get(finishedBlocks);
				let index = previous.messageId === id ? previous.count : 0;
				for (const block of content) {
					const itemId = `${id}:${index++}`;
					if ("text" in block) {
						yield* session.emit({
							type: "message.completed",
							itemId,
							text: block.text,
						});
					} else if ("thinking" in block) {
						// With display "omitted" the block arrives empty, and there is nothing to show.
						if (block.thinking !== "") {
							yield* session.emit({
								type: "reasoning.completed",
								itemId,
								text: block.thinking,
							});
						}
					} else if ("name" in block) {
						if (block.name === EXIT_PLAN_MODE || block.name === ASK_USER_QUESTION) {
							cardTools.add(block.id);
							continue;
						}
						const tool = toToolCall(block.name, block.input);
						tools.set(block.id, tool);
						yield* session.emit({
							type: "tool.started",
							itemId: block.id,
							tool,
						});
					}
				}
				return yield* Ref.set(finishedBlocks, { messageId: id, count: index });
			}
			case "user": {
				if (!("message" in message)) return;
				const { content } = message.message;
				if (typeof content === "string") return;
				for (const block of content) {
					if (!("tool_use_id" in block)) continue;
					if (cardTools.delete(block.tool_use_id)) continue;
					const tool = tools.get(block.tool_use_id) ?? {
						kind: "other",
						name: "unknown",
					};
					tools.delete(block.tool_use_id);
					yield* session.emit({
						type: "tool.completed",
						itemId: block.tool_use_id,
						tool,
						status: block.is_error ? "failed" : "completed",
						output: toolResultText(block.content),
					});
				}
				return;
			}
			case "result": {
				if (!("uuid" in message)) return;
				const failure = [...(message.errors ?? []), ...(message.is_error ? [message.result ?? ""] : [])].join("; ");
				if (isAuthFailureText(failure)) {
					return yield* new AgentAuthError({ agent: "claude", cause: failure });
				}
				// A tool claude cut off, as on a Stop, never gets a result, so it ends with claude's turn rather than
				// running forever in the chat.
				for (const [itemId, tool] of tools) {
					yield* session.emit({ type: "tool.completed", itemId, tool, status: "failed", output: null });
				}
				tools.clear();
				cardTools.clear();
				const usage = yield* Ref.getAndSet(lastUsage, Option.none());
				if (Option.isSome(usage)) {
					yield* session.emit({
						type: "usage.updated",
						contextTokens: usage.value.contextTokens,
						contextWindow: message.modelUsage?.[usage.value.model]?.contextWindow ?? null,
					});
				}
				// claude may run a steer as a turn of its own, whose result follows the running turn's. The turn Octopus
				// started ends only with the result for the last message it sent, so no result ends a later turn.
				if (message.user_message_uuid !== undefined && message.user_message_uuid !== (yield* Ref.get(lastSent))) {
					yield* Effect.logDebug("Claude ended a turn a later message continues");
					// A Stop ended the running turn, but claude keeps a queued steer and runs it next, so it is stopped too.
					if (yield* Ref.get(interrupting)) yield* interruptAgain;
					return;
				}
				const interrupted = yield* Ref.getAndSet(interrupting, false);
				return yield* session.emit({
					type: "turn.completed",
					turnId: message.uuid,
					result: interrupted
						? { status: "interrupted" }
						: message.subtype === "success"
							? { status: "completed" }
							: {
									status: "failed",
									message: message.errors?.join("; ") || message.subtype,
								},
				});
			}
			case "rate_limit_event": {
				if (!("rate_limit_info" in message)) return;
				const { status, resetsAt, rateLimitType, utilization } = message.rate_limit_info;
				return yield* session.emit({
					type: "rateLimit.updated",
					window: (rateLimitType && windowNames[rateLimitType]) ?? "Usage limit",
					status: status === "allowed_warning" ? "warning" : status,
					// The SDK reports utilization as a fraction of the window.
					usedPercent: utilization === undefined ? null : utilization * 100,
					resetsAt: resetsAt === undefined ? null : epochSecondsToIso(resetsAt),
				});
			}
			default:
				return yield* Effect.logDebug("Ignoring Claude message").pipe(Effect.annotateLogs({ type: message.type }));
		}
	});

	return { handle, interrupting, lastSent };
});

// claude runs its own claude.ai sign-in on a terminal. Octopus shows its link and passes it a
// pasted code, and claude stores the tokens itself.
export interface ClaudeAgentAdapter extends AgentAdapter {
	// Returns the link to open. claude also opens it in the browser itself.
	readonly startLogin: Effect.Effect<string, AgentError>;
	// The code claude.ai shows when the browser cannot return to claude by itself.
	submitLoginCode(code: string): Effect.Effect<void, LoginNotPendingError>;
	readonly loginResults: Stream.Stream<{ readonly success: boolean }>;
}

export class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAgentAdapter>()(
	"octopus/daemon/agents/claude/ClaudeAdapter",
) {
	static readonly layer = Layer.effect(
		ClaudeAdapter,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const fs = yield* FileSystem.FileSystem;
			// A string with a default cannot fail to read.
			const configDir = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
				Config.withDefault(join(homedir(), ".claude")),
				Effect.orDie,
			);
			const claudeQuery = yield* ClaudeQuery;
			const registry = yield* ProcessRegistry;
			// Holds the sign-in waiting for the browser. A new sign-in replaces it and stops its claude.
			const pendingLogin = yield* FiberHandle.make();
			const loginTerminal = yield* Ref.make(Option.none<Bun.Terminal>());
			const loginResults = yield* PubSub.unbounded<{ readonly success: boolean }>();
			yield* Effect.addFinalizer(() => PubSub.shutdown(loginResults));

			const checkAuth = Effect.gen(function* () {
				const { executable } = yield* ClaudeAdapterConfig;
				const output = yield* spawner
					.string(
						ChildProcess.make(
							executable,
							// Flag settings must come before the subcommand.
							["--settings", JSON.stringify(blankSettings(credentialEnv, true)), "auth", "status", "--json"],
							{ env: unsetCredentials, extendEnv: true },
						),
					)
					.pipe(Effect.mapError(toAgentError(executable, "Could not run claude auth status.")));
				const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeAuthStatus))(output);
				if (Option.isNone(decoded)) {
					yield* Effect.logWarning("Could not read claude auth status output");
					return { status: "unknown" } satisfies AgentAuthStatus;
				}
				const { loggedIn, email, authMethod } = decoded.value;
				const status: AgentAuthStatus = loggedIn
					? { status: "loggedIn", account: email ?? authMethod ?? null }
					: { status: "loggedOut" };
				return status;
			}).pipe(Effect.withSpan("ClaudeAdapter.checkAuth"));

			const startLogin = Effect.gen(function* () {
				const { executable } = yield* ClaudeAdapterConfig;
				if (Bun.which(executable) === null) {
					return yield* new AgentNotInstalledError({ executable });
				}
				const scope = yield* Scope.make();
				const closeScope = Scope.close(scope, Exit.void);
				const linkShown = yield* Deferred.make<string>();
				const decoder = new TextDecoder();
				let printed = "";
				const { terminal, exited } = yield* spawnTerminal({
					command: [executable, "auth", "login", "--claudeai"],
					cwd: homedir(),
					// Wide enough that claude never wraps the link.
					cols: 1000,
					rows: 40,
					onData: (data) => {
						printed = keepOutputTail(printed + decoder.decode(data, { stream: true }));
						const url = findLoginUrl(printed);
						if (url !== null) Deferred.doneUnsafe(linkShown, Effect.succeed(url));
					},
				}).pipe(
					Scope.provide(scope),
					Effect.mapError((cause) => new AgentProcessError({ message: "Could not start claude auth login.", cause })),
					Effect.onError(() => closeScope),
				);
				const stoppedEarly = exited.pipe(
					// Built once claude has stopped, so the error carries what it printed.
					Effect.andThen(
						Effect.suspend(() =>
							Effect.fail(
								new AgentProcessError({ message: "claude stopped before it showed a sign-in link.", cause: printed }),
							),
						),
					),
				);
				const url = yield* Deferred.await(linkShown).pipe(
					Effect.raceFirst(stoppedEarly),
					Effect.timeoutOrElse({
						duration: LOGIN_LINK_TIMEOUT,
						orElse: () =>
							Effect.fail(new AgentProcessError({ message: "claude did not show a sign-in link.", cause: printed })),
					}),
					Effect.onError(() => closeScope),
				);
				// claude must keep running after this call, or the browser sign-in has nothing to return to.
				yield* Ref.set(loginTerminal, Option.some(terminal)).pipe(
					Effect.andThen(exited),
					// A sign-in the user never finishes also ends, so watchers are not left waiting.
					Effect.timeoutOption(LOGIN_TIMEOUT),
					Effect.flatMap((code) =>
						Effect.gen(function* () {
							const success = Option.isSome(code) && code.value === 0;
							if (!success) {
								yield* Effect.logWarning("Claude sign-in failed").pipe(
									Effect.annotateLogs({ code: Option.getOrNull(code) }),
								);
							}
							yield* PubSub.publish(loginResults, { success });
						}),
					),
					Effect.ensuring(
						Ref.update(loginTerminal, (current) =>
							Option.isSome(current) && current.value === terminal ? Option.none() : current,
						).pipe(Effect.andThen(closeScope)),
					),
					FiberHandle.run(pendingLogin),
				);
				return url;
			}).pipe(Effect.provideService(ProcessRegistry, registry), Effect.withSpan("ClaudeAdapter.startLogin"));

			const submitLoginCode = Effect.fn("ClaudeAdapter.submitLoginCode")(function* (code: string) {
				const terminal = yield* Ref.get(loginTerminal);
				if (Option.isNone(terminal)) {
					return yield* new LoginNotPendingError({ agent: "claude" });
				}
				terminal.value.write(`${code.trim()}\r`);
			});

			// The settings files claude reads for this session, as its settingSources pick them.
			const settingsCredentials = Effect.fnUntraced(function* (input: StartSessionInput) {
				const files = [
					join(configDir, "settings.json"),
					...(input.trustProjectSettings
						? [join(input.cwd, ".claude", "settings.json"), join(input.cwd, ".claude", "settings.local.json")]
						: []),
				];
				const found = yield* Effect.forEach(files, (file) =>
					fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ClaudeSettingsFile)), Effect.option),
				);
				const settings = found.flatMap((file) => (Option.isSome(file) ? [file.value] : []));
				const names = new Set(settings.flatMap((file) => Object.keys(file.env ?? {})));
				const apiKeyHelper = settings.some((file) => file.apiKeyHelper !== undefined);
				// An API key session empties nothing, so a host or provider the user set in a settings file still applies.
				return blankSettings(
					input.auth.mode === "subscription" ? credentialEnv.filter((name) => names.has(name)) : [],
					apiKeyHelper,
				);
			});

			const startSession = Effect.fn("ClaudeAdapter.startSession")(function* (input: StartSessionInput) {
				const { executable } = yield* ClaudeAdapterConfig;
				// The SDK wants a path, not a command name.
				const executablePath = Bun.which(executable);
				if (executablePath === null) {
					return yield* new AgentNotInstalledError({ executable });
				}
				const session = yield* makeAgentSession(capabilities);
				const credentialSettings = yield* settingsCredentials(input);
				const prompts = yield* Queue.unbounded<SDKUserMessage>();
				const context = yield* Effect.context();
				const runPromise = Effect.runPromiseWith(context);
				const { handle, interrupting, lastSent } = yield* makeMessageHandler(
					session,
					// Sent on its own fiber, so the reader goes on delivering claude's messages while claude answers it.
					Effect.suspend(() =>
						Effect.sync(() =>
							Effect.runForkWith(context)(
								Effect.tryPromise(() => run.interrupt()).pipe(
									Effect.catch((error) => Effect.logWarning("Could not stop a steer claude still had queued", error)),
								),
							),
						),
					),
				);
				const sessionScope = yield* Effect.scope;
				let claudePid: number | undefined;

				const proposePlan = (toolInput: Record<string, unknown>, request: Parameters<CanUseTool>[2]) =>
					Effect.gen(function* () {
						const answered = yield* Deferred.make<PlanOutcome>();
						yield* session.proposePlan(
							{
								requestId: request.toolUseID,
								itemId: request.toolUseID,
								text: planText(toolInput),
								choices: buildModes(input.trustProjectSettings),
							},
							(outcome) => Deferred.succeed(answered, outcome).pipe(Effect.as(Option.none())),
						);
						const withdraw = () => Effect.runForkWith(context)(session.cancelPlan(request.toolUseID));
						if (request.signal.aborted) withdraw();
						request.signal.addEventListener("abort", withdraw, { once: true });
						const outcome = yield* Deferred.await(answered).pipe(
							Effect.ensuring(Effect.sync(() => request.signal.removeEventListener("abort", withdraw))),
						);
						return toPlanPermissionResult(outcome, toolInput);
					});

				const askQuestions = (
					toolInput: Record<string, unknown>,
					questions: (typeof AskUserQuestionInput.Type)["questions"],
					request: Parameters<CanUseTool>[2],
				) =>
					Effect.gen(function* () {
						const answered = yield* Deferred.make<QuestionOutcome>();
						yield* session.askQuestions(
							{
								requestId: request.toolUseID,
								itemId: request.toolUseID,
								questions: questions.map((question, index) => ({
									id: `q${index}`,
									header: question.header,
									question: question.question,
									options: question.options.map(({ label, description }) => ({ label, description })),
									multiSelect: question.multiSelect,
									allowsOther: true,
									secret: false,
								})),
							},
							(outcome) => Deferred.succeed(answered, outcome),
						);
						const withdraw = () => Effect.runForkWith(context)(session.cancelQuestions(request.toolUseID));
						if (request.signal.aborted) withdraw();
						request.signal.addEventListener("abort", withdraw, { once: true });
						const outcome = yield* Deferred.await(answered).pipe(
							Effect.ensuring(Effect.sync(() => request.signal.removeEventListener("abort", withdraw))),
						);
						return toQuestionPermissionResult(outcome, toolInput, questions);
					});

				const canUseTool: CanUseTool = (toolName, toolInput, request) =>
					runPromise(
						Effect.gen(function* () {
							if (toolName === EXIT_PLAN_MODE) return yield* proposePlan(toolInput, request);
							// Input Octopus cannot read falls back to a plain approval, so the turn is never stuck.
							const questions = toolName === ASK_USER_QUESTION ? decodeQuestions(toolInput) : Option.none();
							if (Option.isSome(questions)) return yield* askQuestions(toolInput, questions.value.questions, request);
							const suggestions = sessionAllowRules(request.suggestions ?? []);
							const choices: ReadonlyArray<ApprovalDecision> =
								suggestions.length > 0 && !request.suppressAlwaysAllowRule
									? ["allowOnce", "allowForSession", "deny"]
									: ["allowOnce", "deny"];
							const answered = yield* Deferred.make<ApprovalOutcome>();
							yield* session.requestApproval(
								{
									requestId: request.toolUseID,
									itemId: request.toolUseID,
									kind: toToolCall(toolName, toolInput).kind,
									summary: request.title ?? request.displayName ?? toolName,
									reason: request.decisionReason ?? null,
									choices,
								},
								(outcome) => Deferred.succeed(answered, outcome),
							);
							// The SDK aborts a request it no longer needs. Withdraw it, or the session waits on it forever.
							const withdraw = () => Effect.runForkWith(context)(session.cancelApproval(request.toolUseID));
							if (request.signal.aborted) withdraw();
							request.signal.addEventListener("abort", withdraw, { once: true });
							const outcome = yield* Deferred.await(answered).pipe(
								Effect.ensuring(Effect.sync(() => request.signal.removeEventListener("abort", withdraw))),
							);
							return toPermissionResult(outcome, toolInput, suggestions);
						}),
					);

				const options: Options = {
					cwd: input.cwd,
					includePartialMessages: true,
					// Claude Code omits thinking text unless asked, and Octopus shows it.
					thinking: { type: "adaptive", display: "summarized" },
					canUseTool,
					// Without it Claude refuses to switch a running session to bypassPermissions, as Full access
					// and approving a plan in Full access do. Only a trusted project may offer that mode.
					allowDangerouslySkipPermissions: input.trustProjectSettings,
					settingSources: input.trustProjectSettings ? ["user", "project", "local"] : ["user"],
					settings: credentialSettings,
					pathToClaudeCodeExecutable: executablePath,
					spawnClaudeCodeProcess: (spawnOptions) => {
						// The SDK passes the daemon's whole environment, so tools keep SSH agents, toolchains and the like.
						const env = withoutCredentials(spawnOptions.env);
						const child = spawnInProcessGroup({
							...spawnOptions,
							env:
								input.auth.mode === "apiKey" ? { ...env, ANTHROPIC_API_KEY: Redacted.value(input.auth.apiKey) } : env,
						});
						claudePid = child.pid;
						if (child.pid !== undefined) Effect.runForkWith(context)(registry.add(child.pid));
						return child;
					},
				};

				// Only Octopus changes these, so a failed change goes back to them. Claude may change its mode by itself.
				// A run that replaces one that could not resume starts on them, not on the settings the chat opened with.
				const settings = yield* Ref.make({ model: input.model, effort: input.effort, mode: input.mode });

				// Each run has its own scope, so a claude that could not resume is stopped before the next one starts.
				const startRun = Effect.fnUntraced(function* (resume: string | undefined) {
					const scope = yield* Scope.fork(sessionScope);
					// claude gets no message before it has started, so one that cannot start leaves them queued for the next.
					const started = yield* Deferred.make<void>();
					const { model, effort, mode } = yield* Ref.get(settings);
					const run = yield* Effect.acquireRelease(
						Effect.sync(() =>
							claudeQuery.start({
								prompt: Stream.toAsyncIterable(
									Stream.fromEffectDrain(Deferred.await(started)).pipe(Stream.concat(Stream.fromQueue(prompts))),
								),
								options: {
									...options,
									model,
									// Always set, so a settings file can never pick bypassPermissions on its own.
									permissionMode: permissionModes[mode],
									...Option.match(decodeEffort(effort), { onNone: () => ({}), onSome: (effort) => ({ effort }) }),
									...(resume === undefined ? {} : { resume }),
								},
							}),
						),
						(run) =>
							Effect.gen(function* () {
								// Closing ends claude's stdin. Its process group then gets the usual stop signal and grace.
								run.close();
								if (claudePid === undefined) return;
								yield* stopProcessGroup(claudePid);
								yield* registry.remove(claudePid);
							}),
					).pipe(Scope.provide(scope));
					yield* Effect.tryPromise(() => run.initializationResult()).pipe(
						Effect.andThen(Deferred.succeed(started, undefined)),
						// A claude that cannot start says why in its messages, which end the session.
						Effect.ignore,
						Effect.forkIn(scope),
					);
					return { run, scope };
				});

				// Ends early, returning true, when claude has no transcript for the session it was asked to resume.
				const readMessages = (run: ClaudeQueryRun) =>
					Stream.fromAsyncIterable(run.messages, (cause) =>
						isAuthFailureText(String(cause))
							? new AgentAuthError({ agent: "claude", cause })
							: new AgentProcessError({ message: "Claude Code stopped.", cause }),
					).pipe(
						Stream.mapEffect((message) =>
							Schema.decodeUnknownEffect(ClaudeMessage)(message).pipe(
								Effect.mapError(
									(cause) =>
										new AgentProtocolError({
											message: "Claude Code sent a message Octopus could not read.",
											cause,
										}),
								),
							),
						),
						Stream.takeUntil(isMissingSession),
						Stream.tap((message) => (isMissingSession(message) ? Effect.void : handle(message))),
						Stream.runLast,
						Effect.map(Option.exists(isMissingSession)),
					);

				const first = yield* startRun(input.resumeId);
				let run = first.run;

				yield* Effect.gen(function* () {
					if (!(yield* readMessages(run))) return;
					// A session whose transcript is gone can never resume, so the chat goes on in a new one rather
					// than failing every message.
					yield* Effect.logWarning("Claude Code lost the chat's session, starting a new one");
					yield* session.emit({
						type: "error",
						message:
							"Claude Code could not find this chat's earlier conversation, so it continues in a new one without that context.",
						willRetry: false,
					});
					yield* Scope.close(first.scope, Exit.void);
					run = (yield* startRun(undefined)).run;
					yield* readMessages(run);
				}).pipe(Effect.andThen(session.end), Effect.catch(session.fail), Effect.forkScoped);

				const settingsError = (cause: unknown) =>
					new AgentProcessError({ message: "Could not change the chat's settings.", cause });
				const setModelAndEffort = ({ model, effort }: { readonly model: string; readonly effort: string | null }) =>
					Effect.tryPromise({
						try: async () => {
							await run.setModel(model);
							await run.setEffort(Option.getOrNull(decodeEffort(effort)));
						},
						catch: settingsError,
					});

				const sendMessage = ({ text, images }: UserMessage) =>
					Effect.gen(function* () {
						const uuid = randomUUID();
						yield* Ref.set(lastSent, uuid);
						yield* Queue.offer(prompts, {
							uuid,
							type: "user",
							message: {
								role: "user",
								content:
									images.length === 0
										? text
										: [
												...images.map(({ mediaType, base64 }) => ({
													type: "image" as const,
													source: { type: "base64" as const, media_type: mediaType, data: base64 },
												})),
												{ type: "text" as const, text },
											],
							},
							parent_tool_use_id: null,
						});
					});

				return yield* session.start({
					// An interrupt that arrived after the last turn's result must not mark this one.
					startTurn: (message) => Ref.set(interrupting, false).pipe(Effect.andThen(sendMessage(message))),
					steerTurn: (message) => Effect.as(sendMessage(message), true),
					updateSettings: (next) =>
						Effect.gen(function* () {
							const previous = yield* Ref.get(settings);
							yield* setModelAndEffort(next).pipe(
								Effect.andThen(
									Effect.tryPromise({
										try: () => run.setPermissionMode(permissionModes[next.mode]),
										catch: settingsError,
									}),
								),
								// The caller keeps the stored settings when this fails, so claude goes back to them too.
								Effect.tapError(() =>
									setModelAndEffort(previous).pipe(
										Effect.catchTag("AgentProcessError", (error) =>
											Effect.logWarning("Could not restore the chat's settings", error),
										),
									),
								),
							);
							yield* Ref.set(settings, { model: next.model, effort: next.effort, mode: next.mode });
						}),
					listCommands: Effect.tryPromise({
						try: () => run.supportedCommands(),
						catch: (cause) => new AgentProcessError({ message: "Could not list Claude Code's commands.", cause }),
					}).pipe(
						Effect.map((commands) =>
							commands.map(({ name, description, argumentHint }) => ({
								name: `/${name}`,
								description,
								argumentHint: argumentHint === "" ? null : argumentHint,
							})),
						),
					),
					interruptTurn: Effect.gen(function* () {
						yield* Ref.set(interrupting, true);
						yield* Effect.tryPromise({
							try: () => run.interrupt(),
							catch: (cause) =>
								new AgentProcessError({
									message: "Could not interrupt Claude Code.",
									cause,
								}),
						});
					}),
				});
			});

			return ClaudeAdapter.of({
				kind: "claude",
				capabilities,
				authModes: ["apiKey", "subscription"],
				checkAuth,
				startLogin,
				submitLoginCode,
				loginResults: Stream.fromPubSub(loginResults),
				listModels: Effect.succeed(models),
				startSession,
			});
		}),
	);
}
