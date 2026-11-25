import type {
	CanUseTool,
	Options,
	PermissionResult,
	PermissionUpdate,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ConfigProvider, Duration, Effect, Fiber, Layer, Option, Redacted, Stream } from "effect";
import { ClaudeAdapter, ClaudeAdapterConfig, sessionAllowRules } from "./ClaudeAdapter.ts";
import type { AgentSessionHandle, StartSessionInput } from "../AgentAdapter.ts";
import { testProcessRegistry } from "../../testing/testProcessRegistry.ts";
import { TurnWatchdogSettings } from "../makeAgentSession.ts";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { userMessage } from "../../testing/userMessage.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { ClaudeQuery } from "./ClaudeQuery.ts";

const newSession: StartSessionInput = {
	cwd: "/repo",
	model: "claude-opus-4-5",
	effort: null,
	mode: "ask",
	trustProjectSettings: false,
	auth: { mode: "subscription" },
};

const bashSuggestion: PermissionUpdate = {
	type: "addRules",
	rules: [{ toolName: "Bash", ruleContent: "bun test" }],
	behavior: "allow",
	destination: "session",
};

// A scripted stand-in for the SDK's query(). "approve" in a message asks for a Bash
// approval, and "session" adds a permission suggestion so allowForSession is offered.
const startedWith: Array<Options> = [];
const settingsChanges: Array<unknown> = [];
const prompts: Array<SDKUserMessage> = [];

const makeFakeQuery = (permissions: Array<PermissionResult>) =>
	ClaudeQuery.of({
		start: ({ prompt, options }) => {
			startedWith.push(options);
			let resolveInterrupt = () => {};
			let turn = 0;
			async function* messages() {
				for await (const user of prompt) {
					prompts.push(user);
					turn++;
					const text = typeof user.message.content === "string" ? user.message.content : "";
					if (turn === 1) {
						yield {
							type: "system",
							subtype: "init",
							session_id: options.resume ?? "claude-new",
						};
					}
					if (text.includes("think")) {
						// Recorded from claude 2.1.331 with summarized thinking: the thinking block and the
						// reply share a message id, and each arrives as its own assistant message.
						const delta = (index: number, delta: object) => ({
							type: "stream_event",
							parent_tool_use_id: null,
							event: { type: "content_block_delta", index, delta },
						});
						yield {
							type: "stream_event",
							parent_tool_use_id: null,
							event: { type: "message_start", message: { id: "msg_t" } },
						};
						yield delta(0, { type: "thinking_delta", thinking: "Split 17 by 23", estimated_tokens: null });
						yield delta(0, { type: "thinking_delta", thinking: " into parts.", estimated_tokens: null });
						yield delta(0, { type: "signature_delta", signature: "sig" });
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: {
								id: "msg_t",
								content: [{ type: "thinking", thinking: "Split 17 by 23 into parts.", signature: "sig" }],
							},
						};
						yield delta(1, { type: "text_delta", text: "391" });
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: { id: "msg_t", content: [{ type: "text", text: "391" }] },
						};
						// With display "omitted" a thinking block has no text.
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: { id: "msg_u", content: [{ type: "thinking", thinking: "", signature: "sig" }] },
						};
						yield { type: "result", subtype: "success", uuid: `result-${turn}` };
						continue;
					}
					yield {
						type: "stream_event",
						parent_tool_use_id: null,
						event: { type: "message_start", message: { id: "msg_1" } },
					};
					yield {
						type: "stream_event",
						parent_tool_use_id: null,
						event: {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "Hi" },
						},
					};
					yield {
						type: "assistant",
						parent_tool_use_id: null,
						message: { id: "msg_1", content: [{ type: "text", text: "Hi" }] },
					};
					if (text.includes("leave plan mode")) {
						yield { type: "system", subtype: "status", status: null, permissionMode: "default" };
					}
					if (text.includes("usage")) {
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: {
								id: "msg_2",
								model: "claude-opus-5-5",
								content: [],
								usage: {
									input_tokens: 10,
									output_tokens: 5,
									cache_creation_input_tokens: 100,
									cache_read_input_tokens: 1000,
								},
							},
						};
						yield {
							type: "rate_limit_event",
							rate_limit_info: {
								status: "allowed_warning",
								resetsAt: 1700000000,
								rateLimitType: "five_hour",
								utilization: 0.8,
							},
						};
						yield {
							type: "result",
							subtype: "success",
							uuid: `result-${turn}`,
							modelUsage: { "claude-opus-5-5": { contextWindow: 200000 } },
						};
						continue;
					}
					if (text.includes("bad key")) {
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							error: "authentication_failed",
							message: { id: "msg_2", content: [{ type: "text", text: "Invalid API key · Please run /login" }] },
						};
						yield { type: "result", subtype: "success", is_error: true, uuid: `result-${turn}` };
						continue;
					}
					if (text.includes("revoked")) {
						yield {
							type: "result",
							subtype: "error_during_execution",
							uuid: `result-${turn}`,
							errors: ['API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'],
						};
						continue;
					}
					if (text.includes("flood")) {
						// With the four events above, these fill the session's 256-event buffer exactly, so the
						// reader takes the result and then blocks delivering turn.completed.
						for (let index = 0; index < 252; index++) {
							yield {
								type: "stream_event",
								parent_tool_use_id: null,
								event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } },
							};
						}
						yield { type: "result", subtype: "success", uuid: `result-${turn}` };
						continue;
					}
					if (text.includes("abort")) {
						// The SDK aborts a permission request it no longer needs, for example when the turn ends.
						const controller = new AbortController();
						const permission = options.canUseTool?.(
							"Bash",
							{ command: "bun test" },
							{ signal: controller.signal, toolUseID: "toolu_2", requestId: "req_2" },
						);
						await new Promise((resolve) => setTimeout(resolve, 20));
						controller.abort();
						const result = await permission;
						if (result) permissions.push(result);
						yield { type: "result", subtype: "success", uuid: `result-${turn}` };
						continue;
					}
					if (text.includes("subagent")) {
						// A Task subagent works on its own: only its frames arrive, each marked with the Task's tool use.
						for (let index = 0; index < 4; index++) {
							await new Promise((resolve) => setTimeout(resolve, 100));
							yield {
								type: "assistant",
								parent_tool_use_id: "toolu_task",
								message: { id: `msg_sub${index}`, content: [{ type: "text", text: "Searching" }] },
							};
						}
						yield { type: "result", subtype: "success", uuid: `result-${turn}` };
						continue;
					}
					if (text.includes("ask me")) {
						const input = {
							questions: [
								{
									question: "Which database?",
									header: "Database",
									options: [
										{ label: "SQLite", description: "Local file" },
										{ label: "Postgres", description: "Server" },
									],
									multiSelect: false,
								},
								{
									question: "Which checks?",
									header: "Checks",
									options: [
										{ label: "Lint", description: "Biome" },
										{ label: "Tests", description: "bun test" },
									],
									multiSelect: true,
								},
							],
						};
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: { id: "msg_q", content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input }] },
						};
						const permission = await options.canUseTool?.("AskUserQuestion", input, {
							signal: new AbortController().signal,
							toolUseID: "toolu_q",
							requestId: "req_q",
						});
						if (!permission) return;
						permissions.push(permission);
						yield {
							type: "user",
							parent_tool_use_id: null,
							message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", content: "Answered." }] },
						};
						yield { type: "result", subtype: "success", uuid: `result-${turn}` };
						continue;
					}
					if (text.includes("plan the work")) {
						// Claude Code passes the plan file's contents in the tool's input.
						const input = { plan: "1. Add tests\n2. Fix the bug", planFilePath: "/home/.claude/plans/fix.md" };
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: { id: "msg_p", content: [{ type: "tool_use", id: "toolu_p", name: "ExitPlanMode", input }] },
						};
						const permission = await options.canUseTool?.("ExitPlanMode", input, {
							signal: new AbortController().signal,
							toolUseID: "toolu_p",
							requestId: "req_p",
						});
						if (!permission) return;
						permissions.push(permission);
						if (permission.behavior === "allow") {
							yield {
								type: "user",
								parent_tool_use_id: null,
								message: {
									content: [{ type: "tool_result", tool_use_id: "toolu_p", content: "User has approved your plan." }],
								},
							};
						}
						yield { type: "result", subtype: "success", uuid: `result-${turn}` };
						continue;
					}
					if (text.includes("approve")) {
						const input = { command: "bun test" };
						yield {
							type: "assistant",
							parent_tool_use_id: null,
							message: {
								id: "msg_1",
								content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input }],
							},
						};
						const interrupted = new Promise<void>((resolve) => {
							resolveInterrupt = resolve;
						});
						const request: Parameters<CanUseTool>[2] = {
							signal: new AbortController().signal,
							toolUseID: "toolu_1",
							requestId: "req_1",
							title: "Run bun test",
							suggestions: text.includes("session") ? [bashSuggestion] : [],
						};
						const permission = await options.canUseTool?.("Bash", input, request);
						if (!permission) return;
						permissions.push(permission);
						if (permission.behavior === "deny" && permission.interrupt) {
							await interrupted;
							yield {
								type: "result",
								subtype: "error_during_execution",
								uuid: `result-${turn}`,
							};
							continue;
						}
						yield {
							type: "user",
							parent_tool_use_id: null,
							message: {
								content: [
									{
										type: "tool_result",
										tool_use_id: "toolu_1",
										content: "3 pass",
									},
								],
							},
						};
					}
					yield { type: "result", subtype: "success", uuid: `result-${turn}` };
				}
			}
			return {
				messages: messages(),
				interrupt: async () => resolveInterrupt(),
				setModel: async (model) => void settingsChanges.push({ model }),
				setEffort: async (effort) => void settingsChanges.push({ effort }),
				setPermissionMode: async (permissionMode) => void settingsChanges.push({ permissionMode }),
				supportedCommands: async () => [
					{ name: "review", description: "Review the branch", argumentHint: "" },
					{ name: "fix-issue", description: "Fix a GitHub issue", argumentHint: "<number>" },
				],
				close: () => {},
			};
		},
	});

const fakeClaude = `${import.meta.dir}/fixtures/fakeClaude.ts`;

const runWithClaude = <A, E>(
	program: Effect.Effect<A, E, ClaudeAdapter>,
	permissions: Array<PermissionResult> = [],
	executable = fakeClaude,
) =>
	program.pipe(
		Effect.provide(
			ClaudeAdapter.layer.pipe(
				Layer.provide(Layer.succeed(ClaudeQuery, makeFakeQuery(permissions))),
				Layer.provide(testProcessRegistry),
				Layer.provide(BunServices.layer),
			),
		),
		Effect.provideService(ClaudeAdapterConfig, { executable }),
		Effect.runPromise,
	);

const runSession = <A, E>(
	program: (handle: AgentSessionHandle) => Effect.Effect<A, E>,
	options: {
		input?: StartSessionInput;
		permissions?: Array<PermissionResult>;
		configProvider?: ConfigProvider.ConfigProvider;
	} = {},
) =>
	runWithClaude(
		Effect.gen(function* () {
			const claude = yield* ClaudeAdapter;
			return yield* program(yield* claude.startSession(options.input ?? newSession));
		}).pipe(Effect.scoped, Effect.provide(ConfigProvider.layer(options.configProvider ?? ConfigProvider.fromEnv()))),
		options.permissions,
	);

const takeUntil = (handle: AgentSessionHandle, type: AgentEvent["type"]) =>
	handle.events.pipe(
		Stream.takeUntil((event) => event.type === type),
		Stream.runCollect,
	);

describe("ClaudeAdapter", () => {
	test("reports the login from claude auth status", async () => {
		const status = await runWithClaude(
			Effect.gen(function* () {
				const claude = yield* ClaudeAdapter;
				return yield* claude.checkAuth;
			}),
		);
		expect(status).toEqual({ status: "loggedIn", account: "dev@example.com" });
	});

	test("offers a Claude subscription as well as an API key", async () => {
		const modes = await runWithClaude(Effect.map(ClaudeAdapter, (claude) => claude.authModes));
		expect(modes).toEqual(["apiKey", "subscription"]);
	});

	test("checks the CLI's own login, not an API key in the daemon's environment", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-from-shell";
		const status = await runWithClaude(Effect.flatMap(ClaudeAdapter, (claude) => claude.checkAuth)).finally(() => {
			delete process.env.ANTHROPIC_API_KEY;
		});
		expect(status).toEqual({ status: "loggedIn", account: "dev@example.com" });
	});

	test("subscription mode never hands claude an API key or auth token from the environment", async () => {
		const printed = await runSession(() =>
			Effect.promise(async () => {
				const spawnClaude = startedWith.at(-1)?.spawnClaudeCodeProcess;
				if (spawnClaude === undefined) return "no spawn hook";
				const child = spawnClaude({
					command: "sh",
					args: ["-c", 'printf "%s|%s|%s" "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" "$KEEP"'],
					cwd: "/",
					env: { PATH: "/bin:/usr/bin", ANTHROPIC_API_KEY: "sk-shell", ANTHROPIC_AUTH_TOKEN: "tok", KEEP: "kept" },
					signal: new AbortController().signal,
				});
				let text = "";
				for await (const chunk of child.stdout) text += String(chunk);
				return text;
			}),
		);
		expect(printed).toBe("||kept");
	});

	describe("sign-in", () => {
		const login = <A, E>(program: (claude: ClaudeAdapter["Service"]) => Effect.Effect<A, E>) =>
			runWithClaude(Effect.flatMap(ClaudeAdapter, program));

		test("returns the link claude prints for its browser sign-in", async () => {
			const url = await login((claude) => claude.startLogin);
			expect(url).toBe("https://claude.ai/oauth/authorize?code=true&client_id=test&state=abc");
		});

		test.each([
			["good-code", true],
			["bad-code", false],
		])("a pasted code (%s) finishes the sign-in and reports how it ended", async (code, success) => {
			const results = await login((claude) =>
				Effect.gen(function* () {
					const watched = yield* claude.loginResults.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
					yield* Effect.sleep("20 millis");
					yield* claude.startLogin;
					yield* claude.submitLoginCode(code);
					return yield* Fiber.join(watched);
				}),
			);
			expect(results).toEqual([{ success }]);
		});

		test("a code with no sign-in waiting for it is refused", async () => {
			const error = await login((claude) => Effect.flip(claude.submitLoginCode("good-code")));
			expect(error._tag).toBe("LoginNotPendingError");
		});
	});

	test("maps SDK messages and learns the session id from the first turn", async () => {
		const [id, events] = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("hi"));
				const id = yield* handle.nativeSessionId;
				return [id, yield* takeUntil(handle, "turn.completed")] as const;
			}),
		);
		expect(id).toBe("claude-new");
		expect(events).toEqual([
			{ type: "user.message", itemId: "message-hi", text: "hi", attachments: [] },
			{ type: "session.started", nativeSessionId: "claude-new" },
			{ type: "message.delta", itemId: "msg_1:0", text: "Hi" },
			{ type: "message.completed", itemId: "msg_1:0", text: "Hi" },
			{
				type: "turn.completed",
				turnId: "result-1",
				result: { status: "completed" },
			},
		]);
	});

	test("a subagent that works longer than the idle timeout keeps its turn alive", async () => {
		const events = await runWithClaude(
			Effect.gen(function* () {
				const claude = yield* ClaudeAdapter;
				const handle = yield* claude.startSession(newSession);
				yield* handle.sendMessage(userMessage("subagent"));
				return yield* takeUntil(handle, "turn.completed");
			}).pipe(
				Effect.scoped,
				Effect.provideService(TurnWatchdogSettings, {
					idleTimeout: Duration.millis(250),
					interruptGrace: Duration.millis(100),
				}),
			),
		);
		expect(events.at(-1)).toMatchObject({ type: "turn.completed", result: { status: "completed" } });
	});

	test("streams summarized thinking and stores it under the block's own item id", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("think"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(startedWith.at(-1)?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(events.filter((event) => event.type !== "user.message" && event.type !== "session.started")).toEqual([
			{ type: "reasoning.delta", itemId: "msg_t:0", text: "Split 17 by 23" },
			{ type: "reasoning.delta", itemId: "msg_t:0", text: " into parts." },
			{ type: "reasoning.completed", itemId: "msg_t:0", text: "Split 17 by 23 into parts." },
			{ type: "message.delta", itemId: "msg_t:1", text: "391" },
			{ type: "message.completed", itemId: "msg_t:1", text: "391" },
			{ type: "turn.completed", turnId: "result-1", result: { status: "completed" } },
		]);
	});

	test("round-trips an approval and allows it for the session", async () => {
		const permissions: Array<PermissionResult> = [];
		const [requested, rest] = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("approve for the session"));
					const before = yield* takeUntil(handle, "approval.requested");
					yield* handle.respondToApproval("toolu_1", "allowForSession");
					return [before.slice(-2), yield* takeUntil(handle, "turn.completed")];
				}),
			{ permissions },
		);
		expect(requested).toEqual([
			{
				type: "tool.started",
				itemId: "toolu_1",
				tool: { kind: "command", command: "bun test", cwd: null },
			},
			{
				type: "approval.requested",
				requestId: "toolu_1",
				itemId: "toolu_1",
				kind: "command",
				summary: "Run bun test",
				reason: null,
				choices: ["allowOnce", "allowForSession", "deny"],
			},
		]);
		expect(rest).toEqual([
			{
				type: "approval.resolved",
				requestId: "toolu_1",
				outcome: "allowForSession",
			},
			{
				type: "tool.completed",
				itemId: "toolu_1",
				tool: { kind: "command", command: "bun test", cwd: null },
				status: "completed",
				output: "3 pass",
			},
			{
				type: "turn.completed",
				turnId: "result-1",
				result: { status: "completed" },
			},
		]);
		expect(permissions).toEqual([
			{
				behavior: "allow",
				updatedInput: { command: "bun test" },
				updatedPermissions: [bashSuggestion],
			},
		]);
	});

	test("shows ExitPlanMode as a plan, and approving it switches the mode as Claude Code's plan prompt does", async () => {
		const permissions: Array<PermissionResult> = [];
		const [proposed, next, rest] = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("plan the work"));
					const before = yield* takeUntil(handle, "plan.proposed");
					const next = yield* handle.respondToPlan("toolu_p", { type: "approve", mode: "acceptEdits" });
					return [
						before.filter((event) => event.type !== "message.delta"),
						next,
						yield* takeUntil(handle, "turn.completed"),
					];
				}),
			{ permissions, input: { ...newSession, trustProjectSettings: true } },
		);
		expect(proposed.filter((event) => event.type === "tool.started")).toEqual([]);
		expect(proposed.at(-1)).toEqual({
			type: "plan.proposed",
			requestId: "toolu_p",
			itemId: "toolu_p",
			text: "1. Add tests\n2. Fix the bug",
			choices: ["auto", "acceptEdits", "ask", "fullAccess"],
		});
		expect(next).toEqual(Option.none());
		expect(rest).toEqual([
			{ type: "plan.resolved", requestId: "toolu_p", outcome: { type: "approve", mode: "acceptEdits" } },
			{ type: "turn.completed", turnId: "result-1", result: { status: "completed" } },
		]);
		expect(permissions).toEqual([
			{
				behavior: "allow",
				updatedInput: { plan: "1. Add tests\n2. Fix the bug", planFilePath: "/home/.claude/plans/fix.md" },
				updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
			},
		]);
	});

	test("keeps Claude planning with the user's feedback, and offers no full access on an untrusted project", async () => {
		const permissions: Array<PermissionResult> = [];
		const choices = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("plan the work"));
					const proposed = (yield* takeUntil(handle, "plan.proposed")).at(-1);
					yield* handle.respondToPlan("toolu_p", { type: "revise", feedback: "Use a queue instead." });
					yield* takeUntil(handle, "turn.completed");
					return proposed?.type === "plan.proposed" ? proposed.choices : [];
				}),
			{ permissions },
		);
		expect(choices).toEqual(["auto", "acceptEdits", "ask"]);
		expect(permissions).toEqual([{ behavior: "deny", message: "Use a queue instead." }]);
	});

	test("shows AskUserQuestion as questions and answers it the way Claude Code's own prompt does", async () => {
		const permissions: Array<PermissionResult> = [];
		const events = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("ask me"));
					const asked = yield* takeUntil(handle, "question.asked");
					yield* handle.answerQuestion("toolu_q", { q0: ["Use DuckDB"], q1: ["Lint", "Tests"] });
					return [...asked, ...(yield* takeUntil(handle, "turn.completed"))];
				}),
			{ permissions },
		);
		expect(events.filter((event) => event.type.startsWith("tool."))).toEqual([]);
		expect(events.find((event) => event.type === "question.asked")).toEqual({
			type: "question.asked",
			requestId: "toolu_q",
			itemId: "toolu_q",
			questions: [
				{
					id: "q0",
					header: "Database",
					question: "Which database?",
					options: [
						{ label: "SQLite", description: "Local file" },
						{ label: "Postgres", description: "Server" },
					],
					multiSelect: false,
					allowsOther: true,
					secret: false,
				},
				{
					id: "q1",
					header: "Checks",
					question: "Which checks?",
					options: [
						{ label: "Lint", description: "Biome" },
						{ label: "Tests", description: "bun test" },
					],
					multiSelect: true,
					allowsOther: true,
					secret: false,
				},
			],
		});
		expect(permissions).toEqual([
			{
				behavior: "allow",
				updatedInput: expect.objectContaining({
					answers: { "Which database?": "Use DuckDB", "Which checks?": "Lint, Tests" },
				}),
			},
		]);
	});

	test("stopping the turn tells Claude the questions went unanswered", async () => {
		const permissions: Array<PermissionResult> = [];
		await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("ask me"));
					yield* takeUntil(handle, "question.asked");
					yield* handle.interrupt;
					yield* takeUntil(handle, "turn.completed");
				}),
			{ permissions },
		);
		expect(permissions).toEqual([{ behavior: "deny", message: "The user did not answer the questions." }]);
	});

	test("rejects allowForSession when the SDK offers no session rule", async () => {
		const error = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("approve"));
				yield* takeUntil(handle, "approval.requested");
				return yield* Effect.flip(handle.respondToApproval("toolu_1", "allowForSession"));
			}),
		);
		expect(error._tag).toBe("ApprovalChoiceError");
	});

	test("interrupt denies the pending approval, then interrupts the query", async () => {
		const permissions: Array<PermissionResult> = [];
		const events = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("approve"));
					yield* takeUntil(handle, "approval.requested");
					yield* handle.interrupt;
					return yield* takeUntil(handle, "turn.completed");
				}),
			{ permissions },
		);
		expect(events).toEqual([
			{ type: "approval.resolved", requestId: "toolu_1", outcome: "cancelled" },
			{
				type: "turn.completed",
				turnId: "result-1",
				result: { status: "interrupted" },
			},
		]);
		expect(permissions).toMatchObject([{ behavior: "deny", interrupt: true }]);
	});

	test("an interrupt that lands after a turn ended does not mark the next turn interrupted", async () => {
		const results = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("flood"));
				// Claude has sent its result, but the session is still delivering the turn's events.
				yield* Effect.sleep("100 millis");
				yield* handle.interrupt;
				const first = yield* takeUntil(handle, "turn.completed");
				yield* handle.sendMessage(userMessage("hi again"));
				const second = yield* takeUntil(handle, "turn.completed");
				return [...first, ...second].flatMap((event) => (event.type === "turn.completed" ? [event.result] : []));
			}),
		);
		expect(results).toEqual([{ status: "completed" }, { status: "completed" }]);
	});

	test("an aborted permission request resolves as cancelled, so the session stops awaiting it", async () => {
		const permissions: Array<PermissionResult> = [];
		const [events, error] = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("abort"));
					const events = yield* takeUntil(handle, "turn.completed");
					return [events, yield* Effect.flip(handle.respondToApproval("toolu_2", "allowOnce"))] as const;
				}),
			{ permissions },
		);
		expect(events.filter((event) => event.type.startsWith("approval."))).toEqual([
			expect.objectContaining({ type: "approval.requested", requestId: "toolu_2" }),
			{ type: "approval.resolved", requestId: "toolu_2", outcome: "cancelled" },
		]);
		expect(error._tag).toBe("ApprovalNotFoundError");
		expect(permissions).toMatchObject([{ behavior: "deny" }]);
	});

	test("API key mode passes proxy, certificate and config folder variables to claude", async () => {
		const env = {
			PATH: "/bin",
			HTTPS_PROXY: "http://proxy:8080",
			HTTP_PROXY: "http://proxy:8080",
			NO_PROXY: "localhost",
			NODE_EXTRA_CA_CERTS: "/certs/corp.pem",
			CLAUDE_CONFIG_DIR: "/home/dev/.claude-work",
			XDG_CONFIG_HOME: "/home/dev/.config",
			UNRELATED_SECRET: "keep out",
		};
		await runSession(() => Effect.void, {
			input: { ...newSession, auth: { mode: "apiKey", apiKey: Redacted.make("sk-test") } },
			configProvider: ConfigProvider.fromEnv({ env }),
		});
		const { UNRELATED_SECRET: _, ...passed } = env;
		expect(startedWith.at(-1)?.env).toEqual({ ...passed, ANTHROPIC_API_KEY: "sk-test" });
	});

	test.each(["bad key", "revoked"])("a refused credential (%s) ends the session with an auth error", async (text) => {
		const error = await runSession((handle) =>
			handle.sendMessage(userMessage(text)).pipe(Effect.andThen(Effect.flip(Stream.runDrain(handle.events)))),
		);
		expect(error).toMatchObject({
			_tag: "AgentAuthError",
			agent: "claude",
			message:
				"Claude Code refused its credential. Update the API key or sign in again in Settings, then send your message again.",
		});
	});

	test("resumes an existing session", async () => {
		const id = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("hi"));
					return yield* handle.nativeSessionId;
				}),
			{ input: { ...newSession, resumeId: "claude-old" } },
		);
		expect(id).toBe("claude-old");
	});

	test("loads only user settings and the default mode for an untrusted project", async () => {
		await runSession(() => Effect.void);
		expect(startedWith.at(-1)?.settingSources).toEqual(["user"]);
		expect(startedWith.at(-1)?.permissionMode).toBe("default");
		expect(startedWith.at(-1)?.allowDangerouslySkipPermissions).toBe(false);
	});

	test("loads project settings only when the project is trusted", async () => {
		await runSession(() => Effect.void, {
			input: { ...newSession, trustProjectSettings: true },
		});
		expect(startedWith.at(-1)?.settingSources).toEqual(["user", "project", "local"]);
		expect(startedWith.at(-1)?.permissionMode).toBe("default");
		// So Full access can be picked later in the chat, or to build an approved plan.
		expect(startedWith.at(-1)?.allowDangerouslySkipPermissions).toBe(true);
	});

	test("runs the configured claude instead of the SDK's bundled one", async () => {
		await runSession(() => Effect.void);
		expect(startedWith.at(-1)?.pathToClaudeCodeExecutable).toBe(fakeClaude);
	});

	test("reports a missing claude as not installed", async () => {
		const error = await runWithClaude(
			Effect.gen(function* () {
				const claude = yield* ClaudeAdapter;
				return yield* claude.startSession(newSession);
			}).pipe(Effect.scoped, Effect.flip),
			[],
			"/nonexistent/claude",
		);
		expect(error._tag).toBe("AgentNotInstalledError");
	});
});

describe("sessionAllowRules", () => {
	test("keeps allow rules, forced to this session, and drops everything else", () => {
		const rules = sessionAllowRules([
			{ ...bashSuggestion, destination: "projectSettings" },
			{ type: "setMode", mode: "bypassPermissions", destination: "session" },
			{
				type: "addDirectories",
				directories: ["/"],
				destination: "session",
			},
			{
				type: "replaceRules",
				rules: [{ toolName: "Bash" }],
				behavior: "allow",
				destination: "session",
			},
			{
				type: "addRules",
				rules: [{ toolName: "Bash" }],
				behavior: "deny",
				destination: "session",
			},
		]);
		expect(rules).toEqual([{ ...bashSuggestion, destination: "session" }]);
	});

	test("passes the effort at start and changes model and effort for later turns", async () => {
		await runSession((handle) => handle.updateSettings({ model: "claude-haiku-5-5", effort: "low", mode: "plan" }), {
			input: { ...newSession, effort: "high" },
		});
		expect(startedWith.at(-1)?.effort).toBe("high");
		expect(settingsChanges.slice(-3)).toEqual([
			{ model: "claude-haiku-5-5" },
			{ effort: "low" },
			{ permissionMode: "plan" },
		]);
	});

	test.each([
		["ask", "default"],
		["acceptEdits", "acceptEdits"],
		["plan", "plan"],
		["auto", "auto"],
		["fullAccess", "bypassPermissions"],
	] as const)("starts %s mode as Claude's %s permission mode", async (mode, permissionMode) => {
		await runSession(() => Effect.void, { input: { ...newSession, mode } });
		expect(startedWith.at(-1)?.permissionMode).toBe(permissionMode);
	});

	test("reports the mode Claude switches to by itself, as after an approved plan", async () => {
		const events = await runSession((handle) =>
			handle.sendMessage(userMessage("leave plan mode")).pipe(Effect.andThen(takeUntil(handle, "turn.completed"))),
		);
		expect(events).toContainEqual({ type: "mode.changed", mode: "ask" });
	});

	test("lists Claude's slash commands with their prefix, and no empty argument hint", async () => {
		expect(await runSession((handle) => handle.listCommands)).toEqual([
			{ name: "/review", description: "Review the branch", argumentHint: null },
			{ name: "/fix-issue", description: "Fix a GitHub issue", argumentHint: "<number>" },
		]);
	});

	test("sends images as image blocks before the text", async () => {
		await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage({
					id: "message-1",
					text: "what is this",
					images: [{ id: "image-1", mediaType: "image/png", base64: "aGk=", path: "/data/image-1" }],
				});
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(prompts.at(-1)?.message.content).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
			{ type: "text", text: "what is this" },
		]);
	});

	test("reports context usage at the end of a turn and plan limits as they arrive", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("usage"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.filter((event) => event.type === "usage.updated" || event.type === "rateLimit.updated")).toEqual([
			{
				type: "rateLimit.updated",
				window: "5 hours",
				status: "warning",
				usedPercent: 80,
				resetsAt: "2023-11-14T22:13:20.000Z",
			},
			{ type: "usage.updated", contextTokens: 1115, contextWindow: 200000 },
		]);
	});
});
