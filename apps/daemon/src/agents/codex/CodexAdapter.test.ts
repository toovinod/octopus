import type { AgentSessionHandle, StartSessionInput } from "../AgentAdapter.ts";
import codexVersionFile from "./generated/CODEX_VERSION" with { type: "text" };
import { CodexAdapter, CodexAdapterConfig } from "./CodexAdapter.ts";
import { Duration, Effect, Fiber, Option, Stream } from "effect";
import { TurnWatchdogSettings } from "../makeAgentSession.ts";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { CodexRequestSettings } from "./codexRpcClient.ts";
import { userMessage } from "../../testing/userMessage.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";

const fakeCodex = `${import.meta.dir}/fixtures/fakeCodex.ts`;
const newSession: StartSessionInput = {
	cwd: import.meta.dir,
	model: "gpt-5",
	effort: null,
	mode: "auto",
	trustProjectSettings: false,
	auth: { mode: "subscription" },
};

const runWithCodex = <A, E>(program: Effect.Effect<A, E, CodexAdapter>, executable = fakeCodex) =>
	program.pipe(
		Effect.provide(CodexAdapter.layer),
		Effect.provide(BunServices.layer),
		Effect.provideService(CodexAdapterConfig, { executable }),
		Effect.runPromise,
	);

const runSession = <A, E>(program: (handle: AgentSessionHandle) => Effect.Effect<A, E>, input = newSession) =>
	runWithCodex(
		Effect.gen(function* () {
			const codex = yield* CodexAdapter;
			return yield* program(yield* codex.startSession(input));
		}).pipe(Effect.scoped),
	);

const checkAuth = Effect.gen(function* () {
	const codex = yield* CodexAdapter;
	return yield* codex.checkAuth;
});

const takeUntil = (handle: AgentSessionHandle, type: AgentEvent["type"]) =>
	handle.events.pipe(
		Stream.takeUntil((event) => event.type === type),
		Stream.runCollect,
	);

// Codex numbers its requests from 0 in every app-server, so Octopus prefixes them with the process.
const requestIdOf = (events: ReadonlyArray<AgentEvent>) => {
	const event = events.at(-1);
	return event !== undefined && "requestId" in event ? event.requestId : "";
};

describe("CodexAdapter", () => {
	test("reports the login from account/read", async () => {
		const status = await runWithCodex(checkAuth);
		expect(status).toEqual({ status: "loggedIn", account: "dev@example.com" });
	});

	test("starts the ChatGPT sign-in and returns its URL", async () => {
		const url = await runWithCodex(Effect.flatMap(CodexAdapter, (codex) => codex.startLogin));
		expect(url).toBe("https://auth.example/login");
	});

	test.each([
		["fakeCodex.ts", { success: true, error: null }],
		["failedLoginCodex.ts", { success: false, error: "The sign-in was cancelled." }],
		["abandonedLoginCodex.ts", { success: false, error: "The sign-in did not finish." }],
	])("reports how the ChatGPT sign-in through %s ended", async (fixture, expected) => {
		const result = await runWithCodex(
			Effect.gen(function* () {
				const codex = yield* CodexAdapter;
				const results = yield* codex.loginResults.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
				yield* Effect.yieldNow;
				yield* codex.startLogin;
				return yield* Fiber.join(results);
			}),
			`${import.meta.dir}/fixtures/${fixture}`,
		);
		expect(result).toEqual([expected]);
	});

	test("lists models from every model/list page", async () => {
		const models = await runWithCodex(Effect.flatMap(CodexAdapter, (codex) => codex.listModels));
		expect(models).toEqual({
			models: [
				{
					id: "gpt-first",
					label: "GPT First",
					description: "A test model",
					efforts: ["low", "high"],
					defaultEffort: "low",
					contextWindow: null,
					supportsImages: true,
				},
				{
					id: "gpt-later",
					label: "GPT Later",
					description: "A test model",
					efforts: ["low", "high"],
					defaultEffort: "low",
					contextWindow: null,
					supportsImages: false,
				},
			],
			defaultModel: "gpt-first",
		});
	});

	test("streams a turn with deltas", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("hi"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.filter((event) => event.type === "user.message")).toEqual([
			{ type: "user.message", itemId: "message-hi", text: "hi", attachments: [] },
		]);
		// The thread starts alongside the first message, so their events may come in either order.
		expect(events.filter((event) => event.type !== "user.message")).toEqual([
			{ type: "session.started", nativeSessionId: "thread-new" },
			{ type: "message.delta", itemId: "msg-1", text: "Hel" },
			{ type: "message.delta", itemId: "msg-1", text: "lo" },
			{ type: "message.completed", itemId: "msg-1", text: "Hello" },
			{
				type: "turn.completed",
				turnId: "turn-1",
				result: { status: "completed" },
			},
		]);
	});

	test("streams the reasoning summary, one paragraph per part", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("think"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.filter((event) => event.type.startsWith("reasoning.") || event.type.startsWith("message."))).toEqual([
			{ type: "reasoning.delta", itemId: "rs-1", text: "Read the " },
			{ type: "reasoning.delta", itemId: "rs-1", text: "tests" },
			{ type: "reasoning.delta", itemId: "rs-1", text: "\n\n" },
			{ type: "reasoning.delta", itemId: "rs-1", text: "Then run them" },
			{ type: "reasoning.completed", itemId: "rs-1", text: "Read the tests\n\nThen run them" },
			{ type: "message.completed", itemId: "msg-1", text: "Done" },
		]);
	});

	test("a command that keeps streaming output outlives the idle timeout", async () => {
		const events = await runWithCodex(
			Effect.gen(function* () {
				const handle = yield* Effect.flatMap(CodexAdapter, (codex) => codex.startSession(newSession));
				yield* handle.sendMessage(userMessage("long command"));
				return yield* takeUntil(handle, "turn.completed");
			}).pipe(
				Effect.scoped,
				Effect.provideService(TurnWatchdogSettings, {
					idleTimeout: Duration.millis(250),
					interruptGrace: Duration.millis(100),
				}),
			),
		);
		expect(events.at(-1)).toEqual({ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } });
	});

	test("skips messages it cannot read, answers such a request with an error, and keeps the session", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("garbled"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.filter((event) => event.type === "error")).toHaveLength(2);
		expect(events.find((event) => event.type === "message.completed")).toMatchObject({ text: "error -32602" });
		expect(events.at(-1)).toMatchObject({ type: "turn.completed", result: { status: "completed" } });
	});

	test("stops paging models when Codex repeats a cursor", async () => {
		const { models } = await runWithCodex(
			Effect.flatMap(CodexAdapter, (codex) => codex.listModels),
			`${import.meta.dir}/fixtures/loopingModelsCodex.ts`,
		);
		expect(models.map((model) => model.id)).toEqual(["gpt-first", "gpt-later"]);
	});

	test("a call after the app-server exited fails at once instead of waiting for its deadline", async () => {
		const error = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("quit now"));
				yield* Effect.ignore(Stream.runDrain(handle.events));
				return yield* Effect.flip(handle.listCommands);
			}).pipe(Effect.timeout("2 seconds")),
		);
		expect(error).toMatchObject({ _tag: "AgentProcessError", message: "Codex app-server exited." });
	});

	test("runs a skill named with punctuation after it", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("show the images, then run $tester."));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.find((event) => event.type === "message.completed")).toMatchObject({
			text: JSON.stringify([{ type: "skill", name: "tester", path: "/skills/tester/SKILL.md" }]),
		});
	});

	test("a resume of a thread Codex no longer has goes on in a new thread with a notice", async () => {
		const [id, events] = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("hi"));
					const id = yield* handle.nativeSessionId;
					return [id, yield* takeUntil(handle, "turn.completed")] as const;
				}),
			{ ...newSession, resumeId: "thread-gone" },
		);
		expect(id).toBe("thread-new");
		expect(events).toContainEqual({ type: "session.started", nativeSessionId: "thread-new" });
		expect(events.find((event) => event.type === "error")).toMatchObject({ willRetry: false });
		expect(events.at(-1)).toMatchObject({ type: "turn.completed", result: { status: "completed" } });
	});

	test("cuts huge diffs, each and per event, with a marker", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("big diff"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		const tool = events.find((event) => event.type === "tool.completed");
		const diffs =
			tool?.type === "tool.completed" && tool.tool.kind === "fileChange"
				? tool.tool.changes.map((change) => change.diff)
				: [];
		expect(diffs.map((diff) => diff.replace(/^\++/, "").length > 0)).toEqual([true, true, true, true, true]);
		expect(diffs.reduce((total, diff) => total + diff.length, 0)).toBeLessThan(201_000);
		expect(diffs[0]).toEndWith("(diff cut, 100000 more characters)");
	});

	test("round-trips a command approval", async () => {
		const [requested, rest] = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("approve this"));
				const before = yield* takeUntil(handle, "approval.requested");
				yield* handle.respondToApproval(requestIdOf(before), "allowOnce");
				return [before.at(-1), yield* takeUntil(handle, "turn.completed")];
			}),
		);
		expect(requested).toEqual({
			type: "approval.requested",
			requestId: expect.stringMatching(/:100$/),
			itemId: "cmd-1",
			kind: "command",
			summary: "bun test",
			reason: "Run the tests",
			choices: ["allowOnce", "allowForSession", "deny"],
		});
		expect(rest).toEqual([
			{ type: "approval.resolved", requestId: expect.stringMatching(/:100$/), outcome: "allowOnce" },
			{
				type: "tool.completed",
				itemId: "cmd-1",
				tool: { kind: "command", command: "bun test", cwd: "/repo" },
				status: "completed",
				output: "3 pass",
			},
			{
				type: "turn.completed",
				turnId: "turn-1",
				result: { status: "completed" },
			},
		]);
	});

	test("a resumed chat's approvals never reuse the ids of an earlier app-server", async () => {
		const askOnce = (input: StartSessionInput) =>
			runSession(
				(handle) =>
					Effect.gen(function* () {
						yield* handle.sendMessage(userMessage("approve this"));
						return requestIdOf(yield* takeUntil(handle, "approval.requested"));
					}),
				input,
			);
		const first = await askOnce(newSession);
		const second = await askOnce({ ...newSession, resumeId: "thread-new" });
		expect(second).not.toBe(first);
	});

	test("interrupt cancels a pending approval, then interrupts the turn", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("approve this"));
				yield* takeUntil(handle, "approval.requested");
				yield* handle.interrupt;
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events).toEqual([
			{ type: "approval.resolved", requestId: expect.stringMatching(/:100$/), outcome: "cancelled" },
			{
				type: "turn.completed",
				turnId: "turn-1",
				result: { status: "interrupted" },
			},
		]);
	});

	test("an interrupt sent before Codex names the turn stops it once the name arrives", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("slow"));
				yield* Effect.sleep("50 millis");
				yield* handle.interrupt;
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.at(-1)).toEqual({ type: "turn.completed", turnId: "turn-1", result: { status: "interrupted" } });
	});

	test("a steer sent before Codex names the turn waits for its own turn", async () => {
		const [sent, events] = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("slow"));
				yield* Effect.sleep("50 millis");
				const sent = yield* handle.sendMessage(userMessage("hi"), { steer: true });
				yield* takeUntil(handle, "turn.completed");
				return [sent, yield* takeUntil(handle, "turn.completed")] as const;
			}),
		);
		expect(sent).toBe("queued");
		expect(events.at(-1)).toEqual({ type: "turn.completed", turnId: "turn-2", result: { status: "completed" } });
	});

	test("a turn that finishes before Codex answers turn/start leaves no stale turn behind", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("early"));
				yield* takeUntil(handle, "turn.completed");
				yield* handle.sendMessage(userMessage("slow"));
				yield* Effect.sleep("50 millis");
				yield* handle.interrupt;
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.at(-1)).toEqual({ type: "turn.completed", turnId: "turn-2", result: { status: "interrupted" } });
	});

	test("a turn/start Codex never answers fails that turn and keeps the session", async () => {
		const [first, second] = await runWithCodex(
			Effect.gen(function* () {
				const handle = yield* Effect.flatMap(CodexAdapter, (codex) => codex.startSession(newSession));
				yield* handle.sendMessage(userMessage("hang"));
				const first = yield* takeUntil(handle, "turn.completed");
				yield* handle.sendMessage(userMessage("hi"));
				const second = yield* takeUntil(handle, "turn.completed");
				return [first.at(-1), second.at(-1)];
			}).pipe(Effect.scoped, Effect.provideService(CodexRequestSettings, { timeout: Duration.millis(300) })),
		);
		expect(first).toEqual({
			type: "turn.completed",
			turnId: expect.stringMatching(/^octopus-/),
			result: {
				status: "failed",
				message: "Codex did not answer turn/start in time. Try again, and stop the chat if it keeps happening.",
			},
		});
		expect(second).toMatchObject({ type: "turn.completed", result: { status: "completed" } });
	});

	test.each(["unauthorized", "stream 401", "log in"])(
		"a refused credential (%s) ends the session with an auth error",
		async (text) => {
			const error = await runSession((handle) =>
				handle.sendMessage(userMessage(text)).pipe(Effect.andThen(Effect.flip(Stream.runDrain(handle.events)))),
			);
			expect(error).toMatchObject({ _tag: "AgentAuthError", agent: "codex" });
		},
	);

	test("a turn that fails for another reason keeps the session", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("overloaded"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.at(-1)).toMatchObject({ result: { status: "failed", message: "Codex is overloaded" } });
	});

	test("a control request Codex never answers fails at its deadline", async () => {
		const error = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("approve this"));
				yield* takeUntil(handle, "approval.requested");
				// The fake app-server never answers turn/steer.
				return yield* Effect.flip(
					handle
						.sendMessage(userMessage("steer"), { steer: true })
						.pipe(Effect.provideService(CodexRequestSettings, { timeout: Duration.millis(100) })),
				);
			}),
		);
		expect(error).toMatchObject({
			_tag: "AgentProcessError",
			message: "Codex did not answer turn/steer in time. Try again, and stop the chat if it keeps happening.",
		});
	});

	// Codex trusts a folder for good once a workspace-write thread starts in it, then loads its .codex config.
	test.each([
		["starts", false, undefined, { projects: { [import.meta.dir]: { trust_level: "untrusted" } } }],
		["resumes", false, "thread-old", { projects: { [import.meta.dir]: { trust_level: "untrusted" } } }],
		["starts", true, undefined, null],
	] as const)("%s a thread with trustProjectSettings %p", async (_, trustProjectSettings, resumeId, expected) => {
		const reply = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("thread config"));
					const events = yield* takeUntil(handle, "turn.completed");
					return events.find((event) => event.type === "message.completed");
				}),
			{ ...newSession, trustProjectSettings, ...(resumeId === undefined ? {} : { resumeId }) },
		);
		expect(reply).toMatchObject({ text: JSON.stringify(expected) });
	});

	test("resumes an existing thread", async () => {
		const id = await runSession((handle) => handle.nativeSessionId, {
			...newSession,
			resumeId: "thread-old",
		});
		expect(id).toBe("thread-old");
	});

	test("asks request_user_input questions, and stores no answer to a secret one", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("ask me"));
				const asked = yield* takeUntil(handle, "question.asked");
				yield* handle.answerQuestion(requestIdOf(asked), { db: ["Postgres"], token: ["s3cret"] });
				return [...asked, ...(yield* takeUntil(handle, "turn.completed"))];
			}),
		);
		expect(events.find((event) => event.type === "question.asked")).toEqual({
			type: "question.asked",
			requestId: expect.stringMatching(/:300$/),
			itemId: "input-1",
			questions: [
				{
					id: "db",
					header: "Database",
					question: "Which database?",
					options: [{ label: "SQLite", description: "Local file" }],
					multiSelect: false,
					allowsOther: true,
					secret: false,
				},
				{
					id: "token",
					header: "Token",
					question: "Paste the token",
					options: [],
					multiSelect: false,
					allowsOther: true,
					secret: true,
				},
			],
		});
		expect(events.find((event) => event.type === "question.resolved")).toEqual({
			type: "question.resolved",
			requestId: expect.stringMatching(/:300$/),
			outcome: { type: "answered", answers: { db: ["Postgres"] } },
		});
		expect(events.find((event) => event.type === "message.completed")).toMatchObject({
			text: JSON.stringify({ answers: { db: { answers: ["Postgres"] }, token: { answers: ["s3cret"] } } }),
		});
	});

	test("declines unsupported server requests with method not found", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("elicit"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		const agentEvents = events.filter((event) => event.type !== "user.message");
		expect(agentEvents.map((event) => event.type)).toEqual([
			"session.started",
			"error",
			"message.completed",
			"turn.completed",
		]);
		expect(agentEvents[2]).toMatchObject({ text: "error -32601" });
	});

	test("fails when the installed version is older than the generated types", async () => {
		const error = await runWithCodex(Effect.flip(checkAuth), `${import.meta.dir}/fixtures/outdatedCodex.ts`);
		expect(error).toMatchObject({
			_tag: "CodexVersionMismatchError",
			actual: "0.0.1",
		});
		const pinned = codexVersionFile.trim();
		expect(error.message).toBe(
			`Octopus needs Codex ${pinned} or newer, but the installed codex is 0.0.1. Update Codex to use it with Octopus.`,
		);
	});

	test("accepts a version newer than the generated types", async () => {
		const status = await runWithCodex(checkAuth, `${import.meta.dir}/fixtures/newerCodex.ts`);
		expect(status).toEqual({ status: "loggedIn", account: "dev@example.com" });
	});

	test("reports a missing executable as not installed", async () => {
		const error = await runWithCodex(Effect.flip(checkAuth), "/nonexistent/codex");
		expect(error._tag).toBe("AgentNotInstalledError");
		expect(error.message).toBe(
			"Octopus could not find /nonexistent/codex. Install it, or add its folder to the PATH your login shell sets.",
		);
	});

	test("sends the current model and effort with every turn", async () => {
		const texts = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("settings"));
				const first = yield* takeUntil(handle, "turn.completed");
				yield* handle.updateSettings({ model: "gpt-later", effort: "high", mode: "auto" });
				yield* handle.sendMessage(userMessage("settings"));
				const second = yield* takeUntil(handle, "turn.completed");
				return [...first, ...second].flatMap((event) => (event.type === "message.completed" ? [event.text] : []));
			}),
		);
		expect(texts).toEqual(["gpt-5/null", "gpt-later/high"]);
	});

	test.each([
		["readOnly", "on-request", "readOnly"],
		["ask", "untrusted", "workspaceWrite"],
		["auto", "on-request", "workspaceWrite"],
		["fullAccess", "never", "dangerFullAccess"],
	] as const)("a turn in %s mode asks %s in a %s sandbox", async (mode, approvalPolicy, sandbox) => {
		const reply = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.updateSettings({ model: "gpt-5", effort: null, mode });
				yield* handle.sendMessage(userMessage("policy"));
				const events = yield* takeUntil(handle, "turn.completed");
				return events.find((event) => event.type === "message.completed");
			}),
		);
		expect(reply).toMatchObject({ text: JSON.stringify([approvalPolicy, sandbox]) });
	});

	test("a turn in plan mode asks for Codex's plan collaboration mode and offers its plan once the turn ends", async () => {
		const result = await runSession(
			(handle) =>
				Effect.gen(function* () {
					yield* handle.updateSettings({ model: "gpt-5", effort: "high", mode: "plan" });
					yield* handle.sendMessage(userMessage("plan the work"));
					const events = yield* takeUntil(handle, "plan.proposed");
					const next = yield* handle.respondToPlan("plan-1", { type: "approve", mode: "auto" });
					return { events, next };
				}),
			{ ...newSession, trustProjectSettings: true },
		);
		const sent = result.events.find((event) => event.type === "message.completed");
		expect(sent?.type === "message.completed" ? JSON.parse(sent.text) : null).toEqual({
			experimentalApi: true,
			collaborationMode: {
				mode: "plan",
				settings: { model: "gpt-5", reasoning_effort: "high", developer_instructions: null },
			},
		});
		expect(result.events.slice(-2)).toEqual([
			{ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } },
			{
				type: "plan.proposed",
				requestId: "plan-1",
				itemId: "plan-1",
				text: "1. Add tests\n2. Fix the bug",
				choices: ["auto", "ask", "fullAccess"],
			},
		]);
		// Codex waits for the next message, so approving returns the one its own CLI sends.
		expect(result.next).toEqual(Option.some("Implement the plan."));
	});

	test("leaves plan mode explicitly, sends feedback as the next plan message, and offers no plan from a failed turn", async () => {
		const result = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("plan the work"));
				const outside = (yield* takeUntil(handle, "turn.completed")).find(
					(event) => event.type === "message.completed",
				);
				yield* handle.updateSettings({ model: "gpt-5", effort: null, mode: "plan" });
				yield* handle.sendMessage(userMessage("plan the work"));
				const proposed = (yield* takeUntil(handle, "plan.proposed")).at(-1);
				const feedback = yield* handle.respondToPlan("plan-2", { type: "revise", feedback: "Use a queue." });
				yield* handle.sendMessage(userMessage("plan the work, but it fails"));
				const failed = yield* takeUntil(handle, "turn.completed");
				return { outside, proposed, feedback, failed };
			}),
		);
		expect(
			result.outside?.type === "message.completed" ? JSON.parse(result.outside.text).collaborationMode.mode : null,
		).toBe("default");
		expect(result.proposed).toMatchObject({ type: "plan.proposed", choices: ["auto", "ask"] });
		expect(result.feedback).toEqual(Option.some("Use a queue."));
		expect(result.failed.some((event) => event.type === "plan.proposed")).toBe(false);
	});

	test("passes images as local files", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage({
					id: "message-1",
					text: "images",
					images: [{ id: "image-1", mediaType: "image/png", base64: "aGk=", path: "/data/image-1" }],
				});
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		const reply = events.find((event) => event.type === "message.completed");
		expect(reply).toMatchObject({ text: JSON.stringify([{ type: "localImage", path: "/data/image-1" }]) });
	});

	test("lists enabled skills as $ commands", async () => {
		expect(await runSession((handle) => handle.listCommands)).toEqual([
			{ name: "$tester", description: "Runs the tests", argumentHint: null },
		]);
	});

	test("sends a skill the message names as a skill input, and ignores unknown or disabled ones", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("images: $tester then $off and $nope"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		const reply = events.find((event) => event.type === "message.completed");
		expect(reply).toMatchObject({
			text: JSON.stringify([{ type: "skill", name: "tester", path: "/skills/tester/SKILL.md" }]),
		});
	});

	test("reports context usage and plan limits with readable windows", async () => {
		const events = await runSession((handle) =>
			Effect.gen(function* () {
				yield* handle.sendMessage(userMessage("usage"));
				return yield* takeUntil(handle, "turn.completed");
			}),
		);
		expect(events.filter((event) => event.type === "usage.updated" || event.type === "rateLimit.updated")).toEqual([
			{ type: "usage.updated", contextTokens: 1200, contextWindow: 272000 },
			{
				type: "rateLimit.updated",
				window: "5 hours",
				status: "allowed",
				usedPercent: 42,
				resetsAt: "2023-11-14T22:13:20.000Z",
			},
			{ type: "rateLimit.updated", window: "7 days", status: "rejected", usedPercent: 100, resetsAt: null },
		]);
	});
});
