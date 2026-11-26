import {
	AccountResponse,
	AgentMessageDelta,
	ReasoningSummaryDelta,
	ReasoningSummaryPartAdded,
	CommandApprovalParams,
	decodeCodex,
	ErrorNotification,
	FileChangeApprovalParams,
	UserInputParams,
	ItemNotification,
	LoginCompleted,
	LoginResponse,
	ModelListResponse,
	RateLimitsUpdated,
	type ThreadItem,
	ThreadResponse,
	TokenUsageUpdated,
	TurnCompleted,
	TurnResponse,
	SkillsResponse,
} from "./codexProtocol.ts";
import {
	type AgentAdapter,
	AgentAuthError,
	type AgentAuthStatus,
	type AgentError,
	type AgentModels,
	type AgentProtocolError,
	CodexVersionMismatchError,
	type SessionSettings,
	type StartSessionInput,
	type UserMessage,
} from "../AgentAdapter.ts";
import {
	type CodexIncoming,
	type CodexRpcClient,
	INVALID_PARAMS,
	METHOD_NOT_FOUND,
	makeCodexRpcClient,
} from "./codexRpcClient.ts";
import { Context, Effect, Exit, FiberHandle, Layer, Option, Predicate, PubSub, Ref, Scope, Stream } from "effect";
import type { CommandExecutionApprovalDecision } from "./generated/v2/CommandExecutionApprovalDecision.ts";
import type { AgentCapabilities, AgentMode, AgentModel } from "@repo/contracts/AgentSession";
import type { ApprovalOutcome, PlanOutcome, ToolCall } from "@repo/contracts/AgentEvent";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.ts";
import codexVersionFile from "./generated/CODEX_VERSION" with { type: "text" };
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams.ts";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts";
import { type AgentSession, makeAgentSession } from "../makeAgentSession.ts";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts";
import type { GetAccountParams } from "./generated/v2/GetAccountParams.ts";
import type { SkillsListParams } from "./generated/v2/SkillsListParams.ts";
import type { ModelListParams } from "./generated/v2/ModelListParams.ts";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts";
import type { InitializeParams } from "./generated/InitializeParams.ts";
import packageJson from "../../../package.json" with { type: "json" };
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { UserInput } from "./generated/v2/UserInput.ts";
import { epochSecondsToIso } from "../epochSecondsToIso.ts";
import { isAuthFailureText } from "../isAuthFailureText.ts";
import { keepOutputTail } from "../keepOutputTail.ts";
import { makeUniqueId } from "../makeUniqueId.ts";
import { toAgentError } from "../toAgentError.ts";

const CODEX_VERSION = codexVersionFile.trim();

// Releases bundle a pinned codex binary and point this at it.
export const CodexAdapterConfig = Context.Reference<{
	readonly executable: string;
}>("octopus/daemon/agents/codex/CodexAdapterConfig", {
	defaultValue: () => ({ executable: "codex" }),
});

const capabilities: AgentCapabilities = {
	resume: true,
	interrupt: true,
	fileChangeApprovals: true,
	// Codex asks MCP questions through elicitation requests, which Octopus declines for now.
	mcpApprovals: false,
	steerWhileRunning: true,
	// Plan mode is Codex's plan collaboration mode, part of its experimental app-server API.
	modes: ["auto", "readOnly", "ask", "fullAccess", "plan"],
};

const workspaceWrite: SandboxPolicy = {
	type: "workspaceWrite",
	writableRoots: [],
	networkAccess: false,
	excludeTmpdirEnvVar: false,
	excludeSlashTmp: false,
};

// Sent with every turn. Modes Codex does not offer map to the nearest one it has.
const turnPolicies: Record<AgentMode, Pick<TurnStartParams, "approvalPolicy" | "sandboxPolicy">> = {
	readOnly: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } },
	plan: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } },
	ask: { approvalPolicy: "untrusted", sandboxPolicy: workspaceWrite },
	acceptEdits: { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite },
	auto: { approvalPolicy: "on-request", sandboxPolicy: workspaceWrite },
	fullAccess: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
};

const approvalChoices = ["allowOnce", "allowForSession", "deny"] as const;

// Set on every thread so the user's own Codex config cannot turn Octopus's approvals off.
const threadPolicy = {
	approvalPolicy: "on-request",
	sandbox: "workspace-write",
} as const satisfies Pick<ThreadStartParams, "approvalPolicy" | "sandbox">;

// Codex 0.172.0 trusts a folder for good, in the user's ~/.codex/config.toml, the first time a workspace-write
// thread starts in it, and then loads the folder's .codex config, hooks and exec policies. Marking the folder
// untrusted for the thread keeps a project Octopus does not trust from configuring Codex, and writes nothing.
const projectTrust = ({ cwd, trustProjectSettings }: StartSessionInput) =>
	trustProjectSettings ? {} : { config: { projects: { [cwd]: { trust_level: "untrusted" } } } };

const codexDecisions = {
	allowOnce: "accept",
	allowForSession: "acceptForSession",
	deny: "decline",
	cancelled: "cancel",
} as const satisfies Record<ApprovalOutcome, CommandExecutionApprovalDecision>;

// A rewritten lockfile or generated file can be megabytes. Each diff and each event keep only their start,
// so one change cannot fill the database or a chat's live buffer.
const MAX_DIFF_CHARS = 50_000;
const MAX_EVENT_DIFF_CHARS = 200_000;

const capDiff = (diff: string, limit: number) =>
	diff.length > limit ? `${diff.slice(0, limit)}\n... (diff cut, ${diff.length - limit} more characters)` : diff;

const toToolCall = (item: ThreadItem): ToolCall | undefined => {
	switch (item.type) {
		case "commandExecution":
			return "command" in item ? { kind: "command", command: item.command, cwd: item.cwd } : undefined;
		case "fileChange": {
			if (!("changes" in item)) return undefined;
			let budget = MAX_EVENT_DIFF_CHARS;
			return {
				kind: "fileChange",
				changes: item.changes.map((change) => {
					const limit = Math.min(MAX_DIFF_CHARS, budget);
					budget -= Math.min(change.diff.length, limit);
					return { path: change.path, kind: change.kind.type, diff: capDiff(change.diff, limit) };
				}),
			};
		}
		case "mcpToolCall":
			return "server" in item ? { kind: "mcpCall", server: item.server, tool: item.tool } : undefined;
		default:
			return undefined;
	}
};

const toolStatus = (item: ThreadItem) =>
	"status" in item && (item.status === "failed" || item.status === "declined") ? item.status : "completed";

const toolOutput = (item: ThreadItem) => {
	if ("aggregatedOutput" in item && item.aggregatedOutput !== null) {
		return keepOutputTail(item.aggregatedOutput);
	}
	return "error" in item && item.error !== null ? item.error.message : null;
};

const checkVersion = Effect.fn("CodexAdapter.checkVersion")(function* (executable: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const output = yield* spawner
		.string(ChildProcess.make(executable, ["--version"]))
		.pipe(Effect.mapError(toAgentError(executable, "Could not run codex --version.")));
	// `codex --version` prints "codex-cli <version>".
	const actual = output.trim().split(" ").at(-1) ?? "";
	// The protocol types come from CODEX_VERSION. Newer releases keep that protocol working, and anything
	// they change shows up as a decode error at the boundary, so only an older Codex is refused.
	if (!Bun.semver.satisfies(actual, `>=${CODEX_VERSION}`)) {
		return yield* new CodexVersionMismatchError({
			expected: CODEX_VERSION,
			actual,
		});
	}
});

const initialize = Effect.fn("CodexAdapter.initialize")(function* (client: CodexRpcClient) {
	yield* client.request("initialize", {
		clientInfo: { name: "octopus", title: "Octopus", version: packageJson.version },
		// Plan mode and its collaboration mode setting are only in the experimental API.
		capabilities: { experimentalApi: true, requestAttestation: false },
	} satisfies InitializeParams);
	yield* client.notify("initialized");
});

const appServer = (executable: string, cwd?: string, env?: ChildProcess.CommandOptions["env"]) =>
	ChildProcess.make(executable, ["app-server"], {
		...(cwd === undefined ? {} : { cwd }),
		...(env === undefined ? {} : { env }),
		extendEnv: true,
	});

// Codex sends window lengths in minutes, like 300 for five hours.
const describeWindow = (minutes: number) => {
	const [amount, unit] =
		minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
	return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
};

// Codex names a turn only in its turn/start reply, and the turn may finish before that reply arrives.
type TurnState =
	| { readonly _tag: "idle" }
	| { readonly _tag: "starting"; readonly interruptRequested: boolean }
	| { readonly _tag: "running"; readonly turnId: string };

const idle: TurnState = { _tag: "idle" };

// Codex names a refused credential "unauthorized", forwards an HTTP 401 inside another variant, or
// only says so in the message, as when a ChatGPT sign-in can no longer be refreshed.
const isAuthFailure = (error: { readonly message: string; readonly codexErrorInfo?: unknown }) =>
	error.codexErrorInfo === "unauthorized" ||
	(Predicate.isObject(error.codexErrorInfo) &&
		Object.values(error.codexErrorInfo).some(
			(detail) => Predicate.hasProperty(detail, "httpStatusCode") && detail.httpStatusCode === 401,
		)) ||
	isAuthFailureText(error.message);

const reasoningPartSeparator = "\n\n";

// What Codex's own "Yes, implement this plan" sends.
const IMPLEMENT_PLAN = "Implement the plan.";

// The modes a plan may be built in. Full access needs a trusted project.
const buildModes = (trusted: boolean): ReadonlyArray<AgentMode> =>
	(["auto", "ask", "fullAccess"] as const).filter(
		(mode) => capabilities.modes.includes(mode) && (trusted || mode !== "fullAccess"),
	);

// Codex waits for the next message after a plan. Approving sends Codex's own implement message, and
// feedback goes as the next plan message.
const respondToPlan = (outcome: PlanOutcome) =>
	Effect.succeed(
		outcome.type === "approve"
			? Option.some(IMPLEMENT_PLAN)
			: outcome.type === "revise" && outcome.feedback.trim() !== ""
				? Option.some(outcome.feedback)
				: Option.none(),
	);

// The plan of the running turn. It is offered once the turn completes, as Codex's own prompt is.
interface PlanTracking {
	readonly turnPlan: Ref.Ref<Option.Option<{ readonly id: string; readonly text: string }>>;
	readonly choices: ReadonlyArray<AgentMode>;
}

const handleNotification = Effect.fnUntraced(function* (
	session: AgentSession,
	currentTurn: Ref.Ref<TurnState>,
	plans: PlanTracking,
	method: string,
	params: unknown,
) {
	switch (method) {
		case "item/agentMessage/delta": {
			const { itemId, delta } = yield* decodeCodex(AgentMessageDelta)(params);
			return yield* session.emit({
				type: "message.delta",
				itemId,
				text: delta,
			});
		}
		case "item/reasoning/summaryTextDelta": {
			const { itemId, delta } = yield* decodeCodex(ReasoningSummaryDelta)(params);
			return yield* session.emit({
				type: "reasoning.delta",
				itemId,
				text: delta,
			});
		}
		// Each summary part is its own paragraph, the way the completed item joins them.
		case "item/reasoning/summaryPartAdded": {
			const { itemId, summaryIndex } = yield* decodeCodex(ReasoningSummaryPartAdded)(params);
			if (summaryIndex === 0) return;
			return yield* session.emit({
				type: "reasoning.delta",
				itemId,
				text: reasoningPartSeparator,
			});
		}
		case "item/started": {
			const { item } = yield* decodeCodex(ItemNotification)(params);
			const tool = toToolCall(item);
			if (tool === undefined) return;
			return yield* session.emit({
				type: "tool.started",
				itemId: item.id,
				tool,
			});
		}
		case "item/completed": {
			const { item } = yield* decodeCodex(ItemNotification)(params);
			if (item.type === "plan" && "text" in item) {
				return yield* Ref.set(plans.turnPlan, Option.some({ id: item.id, text: item.text }));
			}
			if (item.type === "agentMessage" && "text" in item) {
				return yield* session.emit({
					type: "message.completed",
					itemId: item.id,
					text: item.text,
				});
			}
			if (item.type === "reasoning" && "summary" in item) {
				const text = item.summary.join(reasoningPartSeparator);
				if (text === "") return;
				return yield* session.emit({
					type: "reasoning.completed",
					itemId: item.id,
					text,
				});
			}
			const tool = toToolCall(item);
			if (tool === undefined) return;
			return yield* session.emit({
				type: "tool.completed",
				itemId: item.id,
				tool,
				status: toolStatus(item),
				output: toolOutput(item),
			});
		}
		case "turn/completed": {
			const { turn } = yield* decodeCodex(TurnCompleted)(params);
			yield* Ref.set(currentTurn, idle);
			const plan = yield* Ref.getAndSet(plans.turnPlan, Option.none());
			if (turn.status === "failed" && turn.error !== null && isAuthFailure(turn.error)) {
				return yield* new AgentAuthError({ agent: "codex", cause: turn.error });
			}
			yield* session.emit({
				type: "turn.completed",
				turnId: turn.id,
				result:
					turn.status === "interrupted"
						? { status: "interrupted" }
						: turn.status === "failed"
							? {
									status: "failed",
									message: turn.error?.message ?? "The turn failed.",
								}
							: { status: "completed" },
			});
			// A stopped or failed turn offers no plan, as in Codex's own prompt.
			if (turn.status !== "completed" || Option.isNone(plan)) return;
			return yield* session.proposePlan(
				{ requestId: plan.value.id, itemId: plan.value.id, text: plan.value.text, choices: plans.choices },
				respondToPlan,
			);
		}
		case "thread/tokenUsage/updated": {
			const { tokenUsage } = yield* decodeCodex(TokenUsageUpdated)(params);
			return yield* session.emit({
				type: "usage.updated",
				contextTokens: tokenUsage.last.totalTokens,
				contextWindow: tokenUsage.modelContextWindow,
			});
		}
		case "account/rateLimits/updated": {
			const { rateLimits } = yield* decodeCodex(RateLimitsUpdated)(params);
			const reached = (rateLimits.rateLimitReachedType ?? null) !== null;
			for (const window of [rateLimits.primary, rateLimits.secondary]) {
				if (window === null) continue;
				// Codex reports no warning level, so a window is either open or used up.
				yield* session.emit({
					type: "rateLimit.updated",
					window: window.windowDurationMins === null ? "Usage limit" : describeWindow(window.windowDurationMins),
					status: reached || window.usedPercent >= 100 ? "rejected" : "allowed",
					usedPercent: window.usedPercent,
					resetsAt: window.resetsAt === null ? null : epochSecondsToIso(window.resetsAt),
				});
			}
			return;
		}
		case "error": {
			const { error, willRetry } = yield* decodeCodex(ErrorNotification)(params);
			return yield* session.emit({
				type: "error",
				message: error.message,
				willRetry,
			});
		}
		default:
			return yield* Effect.logDebug("Ignoring Codex notification").pipe(Effect.annotateLogs({ method }));
	}
});

const handleServerRequest = Effect.fnUntraced(function* (
	session: AgentSession,
	client: CodexRpcClient,
	processId: string,
	request: Extract<CodexIncoming, { _tag: "request" }>,
) {
	const respond = (outcome: ApprovalOutcome) => client.respond(request.id, { decision: codexDecisions[outcome] });
	const requestId = `${processId}:${request.id}`;
	switch (request.method) {
		case "item/commandExecution/requestApproval": {
			const params = yield* decodeCodex(CommandApprovalParams)(request.params);
			return yield* session.requestApproval(
				{
					requestId,
					itemId: params.itemId,
					kind: "command",
					summary: params.command ?? "Run a command",
					reason: params.reason ?? null,
					choices: approvalChoices,
				},
				respond,
			);
		}
		case "item/fileChange/requestApproval": {
			const params = yield* decodeCodex(FileChangeApprovalParams)(request.params);
			return yield* session.requestApproval(
				{
					requestId,
					itemId: params.itemId,
					kind: "fileChange",
					summary: params.grantRoot ? `Allow writes under ${params.grantRoot}` : "Apply file changes",
					reason: params.reason ?? null,
					choices: approvalChoices,
				},
				respond,
			);
		}
		case "item/tool/requestUserInput": {
			const params = yield* decodeCodex(UserInputParams)(request.params);
			return yield* session.askQuestions(
				{
					requestId,
					itemId: params.itemId,
					questions: params.questions.map((question) => ({
						id: question.id,
						header: question.header,
						question: question.question,
						options: question.options ?? [],
						multiSelect: false,
						// A question with no options takes typed text only.
						allowsOther: question.isOther || (question.options ?? []).length === 0,
						secret: question.isSecret,
					})),
				},
				// Unanswered questions get empty answers, so Codex goes on without them.
				(outcome) =>
					client.respond(request.id, {
						answers: Object.fromEntries(
							Object.entries(outcome.type === "answered" ? outcome.answers : {}).map(([id, answers]) => [
								id,
								{ answers },
							]),
						),
					}),
			);
		}
		default:
			// Never leave Codex waiting on a request we cannot answer.
			yield* client.respondError(request.id, METHOD_NOT_FOUND, `Octopus does not support ${request.method}`);
			return yield* session.emit({
				type: "error",
				message: `Codex asked for ${request.method}, which Octopus does not support yet. It was declined.`,
				willRetry: false,
			});
	}
});

// A newer Codex can change the shape of a message. Skipping it keeps the chat going, and a request still
// gets an answer, so Codex is never left waiting.
const skipUnreadable = Effect.fnUntraced(function* (
	session: AgentSession,
	client: CodexRpcClient,
	message: CodexIncoming,
	error: AgentProtocolError,
) {
	yield* Effect.logWarning("Skipping a Codex message Octopus could not read", error).pipe(
		Effect.annotateLogs({ method: message.method }),
	);
	if (message._tag === "request") {
		yield* client.respondError(message.id, INVALID_PARAMS, `Octopus could not read ${message.method}`);
	}
	yield* session.emit({
		type: "error",
		message:
			"Codex sent a message Octopus could not read, so Octopus skipped it. Update Octopus if this keeps happening.",
		willRetry: false,
	});
});

// What Codex answers a thread/resume whose thread it has no record of.
const isMissingThread = (error: AgentError) =>
	error._tag === "AgentProtocolError" && /no rollout found|thread not found/i.test(error.message);

// Codex runs its own ChatGPT sign-in, which Claude has no equivalent for.
export interface CodexAgentAdapter extends AgentAdapter {
	// Returns the URL to open. Codex stores the tokens itself when the user finishes.
	readonly startLogin: Effect.Effect<string, AgentError>;
	// How each sign-in ended, so the daemon can refresh the account and its models without being asked.
	readonly loginResults: Stream.Stream<LoginCompleted>;
}

// "$name" in a message, without the punctuation after it. A name starts with a letter, so "$5" names none.
const SKILL_NAME = /\$[A-Za-z][\w:-]*/g;

// Codex waits on its local callback server until the user finishes in the browser.
const LOGIN_TIMEOUT = "10 minutes";

export class CodexAdapter extends Context.Service<CodexAdapter, CodexAgentAdapter>()(
	"octopus/daemon/agents/codex/CodexAdapter",
) {
	static readonly layer = Layer.effect(
		CodexAdapter,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const provide = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner);
			// Holds the sign-in waiting for the browser. A new sign-in replaces it and stops its app-server.
			const pendingLogin = yield* FiberHandle.make();
			const loginResults = yield* PubSub.unbounded<LoginCompleted>();
			yield* Effect.addFinalizer(() => PubSub.shutdown(loginResults));

			// A short-lived app-server for questions outside a session. Closing the scope stops it.
			const connect = Effect.gen(function* () {
				const { executable } = yield* CodexAdapterConfig;
				yield* checkVersion(executable);
				const client = yield* makeCodexRpcClient(appServer(executable));
				yield* initialize(client);
				return client;
			});

			const checkAuth = Effect.gen(function* () {
				const client = yield* connect;
				const { account, requiresOpenaiAuth } = yield* client
					.request("account/read", {
						refreshToken: false,
					} satisfies GetAccountParams)
					.pipe(Effect.flatMap(decodeCodex(AccountResponse)));
				const status: AgentAuthStatus =
					account === null
						? requiresOpenaiAuth
							? { status: "loggedOut" }
							: { status: "unknown" }
						: {
								status: "loggedIn",
								account: "email" in account ? account.email : account.type,
							};
				return status;
			}).pipe(Effect.scoped, provide, Effect.withSpan("CodexAdapter.checkAuth"));

			// The installed Codex knows which models the account can use, so the list comes from it.
			const listModels = Effect.gen(function* () {
				const client = yield* connect;
				const models: Array<AgentModel> = [];
				let defaultModel = "";
				let cursor: string | null = null;
				// A cursor Codex already sent would page forever.
				const seenCursors = new Set<string>();
				do {
					const page: typeof ModelListResponse.Type = yield* client
						.request("model/list", { cursor } satisfies ModelListParams)
						.pipe(Effect.flatMap(decodeCodex(ModelListResponse)));
					for (const model of page.data) {
						// model/list has no context window. Codex reports it per thread in its token usage instead.
						models.push({
							id: model.id,
							label: model.displayName,
							description: model.description,
							efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
							defaultEffort: model.defaultReasoningEffort,
							contextWindow: null,
							supportsImages: model.inputModalities.includes("image"),
						});
						if (model.isDefault) defaultModel = model.id;
					}
					cursor = page.nextCursor;
					if (cursor !== null && seenCursors.has(cursor)) {
						yield* Effect.logWarning("Codex repeated a model/list cursor, so Octopus stopped paging");
						break;
					}
					if (cursor !== null) seenCursors.add(cursor);
				} while (cursor !== null);
				return { models, defaultModel: defaultModel || (models[0]?.id ?? "") } satisfies AgentModels;
			}).pipe(Effect.scoped, provide, Effect.withSpan("CodexAdapter.listModels"));

			const startLogin = Effect.gen(function* () {
				const scope = yield* Scope.make();
				const login = yield* Effect.gen(function* () {
					const client = yield* connect;
					const { authUrl } = yield* client
						.request("account/login/start", { type: "chatgpt" } satisfies LoginAccountParams)
						.pipe(Effect.flatMap(decodeCodex(LoginResponse)));
					return { client, authUrl };
				}).pipe(
					Scope.provide(scope),
					Effect.onError(() => Scope.close(scope, Exit.void)),
				);
				// The app-server must outlive this call, or the browser sign-in has nothing to return to.
				yield* login.client.incoming.pipe(
					Stream.filter((message) => message._tag === "notification" && message.method === "account/login/completed"),
					Stream.take(1),
					Stream.mapEffect((message) => decodeCodex(LoginCompleted)(message.params)),
					Stream.runHead,
					Effect.timeoutOption(LOGIN_TIMEOUT),
					Effect.map(Option.flatten),
					Effect.catch((error) =>
						Effect.logWarning("Codex sign-in stopped", error).pipe(Effect.as(Option.none<LoginCompleted>())),
					),
					// A sign-in that times out or whose app-server exits also ends, so watchers are not left waiting.
					Effect.map(
						Option.getOrElse((): LoginCompleted => ({ success: false, error: "The sign-in did not finish." })),
					),
					Effect.flatMap((result) =>
						Effect.gen(function* () {
							if (!result.success) {
								yield* Effect.logWarning("Codex sign-in failed").pipe(Effect.annotateLogs({ error: result.error }));
							}
							yield* PubSub.publish(loginResults, result);
						}),
					),
					Effect.ensuring(Scope.close(scope, Exit.void)),
					FiberHandle.run(pendingLogin),
				);
				return login.authUrl;
			}).pipe(provide, Effect.withSpan("CodexAdapter.startLogin"));

			const startSession = Effect.fn("CodexAdapter.startSession")(function* (input: StartSessionInput) {
				const { executable } = yield* CodexAdapterConfig;
				yield* checkVersion(executable);
				const session = yield* makeAgentSession(capabilities);
				const processId = yield* makeUniqueId;
				const currentTurn = yield* Ref.make(idle);
				const plans: PlanTracking = {
					turnPlan: yield* Ref.make(Option.none<{ readonly id: string; readonly text: string }>()),
					choices: buildModes(input.trustProjectSettings),
				};
				// Sent with every turn, so a change applies from the next one.
				const settings = yield* Ref.make<SessionSettings>({
					model: input.model,
					effort: input.effort,
					mode: input.mode,
				});
				const client = yield* makeCodexRpcClient(
					appServer(
						executable,
						input.cwd,
						input.auth.mode === "apiKey" ? { OPENAI_API_KEY: input.auth.apiKey } : undefined,
					),
				);

				yield* client.incoming.pipe(
					Stream.runForEach((message) =>
						session.touch.pipe(
							Effect.andThen(
								message._tag === "notification"
									? handleNotification(session, currentTurn, plans, message.method, message.params)
									: handleServerRequest(session, client, processId, message),
							),
							Effect.catchTag("AgentProtocolError", (error) => skipUnreadable(session, client, message, error)),
						),
					),
					Effect.andThen(session.end),
					Effect.catch(session.fail),
					Effect.forkScoped,
				);

				const startThread = client.request("thread/start", {
					model: input.model,
					cwd: input.cwd,
					...threadPolicy,
					...projectTrust(input),
				} satisfies ThreadStartParams);

				yield* Effect.gen(function* () {
					yield* initialize(client);
					const response =
						input.resumeId === undefined
							? yield* startThread
							: yield* client
									.request("thread/resume", {
										threadId: input.resumeId,
										model: input.model,
										cwd: input.cwd,
										...threadPolicy,
										...projectTrust(input),
									} satisfies ThreadResumeParams)
									.pipe(
										// A thread whose files are gone can never resume, so the chat goes on in a new one rather
										// than failing every message.
										Effect.catchIf(isMissingThread, (error) =>
											Effect.gen(function* () {
												yield* Effect.logWarning("Codex lost the chat's thread, starting a new one", error);
												yield* session.emit({
													type: "error",
													message:
														"Codex could not find this chat's earlier conversation, so it continues in a new one without that context.",
													willRetry: false,
												});
												return yield* startThread;
											}),
										),
									);
					const { thread } = yield* decodeCodex(ThreadResponse)(response);
					yield* session.setNativeSessionId(thread.id);
				}).pipe(Effect.catch(session.fail), Effect.forkScoped);

				const listSkills = client.request("skills/list", { cwds: [input.cwd] } satisfies SkillsListParams).pipe(
					Effect.flatMap(decodeCodex(SkillsResponse)),
					Effect.map(({ data }) => data.flatMap(({ skills }) => skills).filter(({ enabled }) => enabled)),
				);

				// A skill runs when the message names it as "$name" and also carries it as an input item,
				// the way Codex's own composer sends it.
				const skillsNamedIn = (text: string) => {
					const named = new Set(text.match(SKILL_NAME));
					return named.size === 0
						? Effect.succeed([])
						: listSkills.pipe(
								Effect.map((skills) =>
									skills
										.filter(({ name }) => named.has(`$${name}`))
										.map(({ name, path }) => ({ type: "skill" as const, name, path })),
								),
							);
				};

				// Codex reads images from disk, so it gets the stored path rather than the bytes.
				const toInput = ({ text, images }: UserMessage) =>
					Effect.map(
						skillsNamedIn(text),
						(skills): Array<UserInput> => [
							{ type: "text", text, text_elements: [] },
							...images.map(({ path }) => ({ type: "localImage" as const, path })),
							...skills,
						],
					);

				const interrupt = (turnId: string) =>
					Effect.gen(function* () {
						const threadId = yield* session.nativeSessionId;
						yield* client.request("turn/interrupt", { threadId, turnId } satisfies TurnInterruptParams);
					});

				return yield* session.start({
					startTurn: (message) =>
						Effect.gen(function* () {
							const threadId = yield* session.nativeSessionId;
							const { model, effort, mode } = yield* Ref.get(settings);
							yield* Ref.set(currentTurn, { _tag: "starting", interruptRequested: false });
							yield* Ref.set(plans.turnPlan, Option.none());
							const { turn } = yield* client
								.request("turn/start", {
									threadId,
									model,
									effort,
									...turnPolicies[mode],
									// Sent every turn, so leaving plan mode is as explicit as entering it. Null instructions
									// use Codex's built-in ones for the mode.
									collaborationMode: {
										mode: mode === "plan" ? "plan" : "default",
										settings: { model, reasoning_effort: effort, developer_instructions: null },
									},
									input: yield* toInput(message),
								} satisfies TurnStartParams)
								.pipe(
									Effect.flatMap(decodeCodex(TurnResponse)),
									Effect.onError(() => Ref.set(currentTurn, idle)),
								);
							// A turn that already finished stays idle, so its id is never reused.
							const before = yield* Ref.getAndUpdate(
								currentTurn,
								(state): TurnState => (state._tag === "starting" ? { _tag: "running", turnId: turn.id } : state),
							);
							if (before._tag === "starting" && before.interruptRequested) yield* interrupt(turn.id);
						}),
					steerTurn: (message) =>
						Effect.gen(function* () {
							const threadId = yield* session.nativeSessionId;
							const state = yield* Ref.get(currentTurn);
							// Codex steers only a turn it has named, so earlier the message waits for its own turn.
							if (state._tag !== "running") return false;
							yield* client.request("turn/steer", {
								threadId,
								input: yield* toInput(message),
								expectedTurnId: state.turnId,
							} satisfies TurnSteerParams);
							return true;
						}),
					updateSettings: (next) => Ref.set(settings, next),
					listCommands: Effect.map(listSkills, (skills) =>
						skills.map(({ name, description, shortDescription }) => ({
							name: `$${name}`,
							description: shortDescription ?? description,
							argumentHint: null,
						})),
					),
					// Before Codex names the turn, the interrupt waits for the name.
					interruptTurn: Effect.gen(function* () {
						const state = yield* Ref.getAndUpdate(currentTurn, (state) =>
							state._tag === "starting" ? { ...state, interruptRequested: true } : state,
						);
						if (state._tag === "running") yield* interrupt(state.turnId);
					}),
				});
			}, provide);

			return CodexAdapter.of({
				kind: "codex",
				capabilities,
				authModes: ["apiKey", "subscription"],
				checkAuth,
				listModels,
				startLogin,
				loginResults: Stream.fromPubSub(loginResults),
				startSession,
			});
		}),
	);
}
