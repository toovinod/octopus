import { type AgentSession, makeAgentSession, TurnWatchdogSettings } from "./makeAgentSession.ts";
import type { AgentEvent, QuestionOutcome, PlanOutcome } from "@repo/contracts/AgentEvent";
import { AgentProtocolError, type AgentSessionHandle } from "./AgentAdapter.ts";
import { Duration, Effect, Option, Stream } from "effect";
import { userMessage } from "../testing/userMessage.ts";
import { describe, expect, test } from "bun:test";

const capabilities = {
	resume: false,
	interrupt: true,
	fileChangeApprovals: false,
	mcpApprovals: false,
	steerWhileRunning: false,
	modes: ["ask"],
} as const;

const watchdog = { idleTimeout: Duration.millis(200), interruptGrace: Duration.millis(200) };

// A driver for an agent that starts every turn and then goes quiet. How it answers an interrupt is up to the test.
const runQuietAgent = <A>(
	onInterrupt: (session: AgentSession) => Effect.Effect<void>,
	program: (handle: AgentSessionHandle, session: AgentSession) => Effect.Effect<A, unknown>,
) =>
	Effect.gen(function* () {
		const session = yield* makeAgentSession(capabilities);
		const handle = yield* session.start({
			startTurn: () => Effect.void,
			steerTurn: () => Effect.succeed(true),
			interruptTurn: onInterrupt(session),
			updateSettings: () => Effect.void,
			listCommands: Effect.succeed([]),
		});
		return yield* program(handle, session);
	}).pipe(Effect.scoped, Effect.provideService(TurnWatchdogSettings, watchdog), Effect.runPromise);

const turnResults = (handle: AgentSessionHandle) =>
	handle.events.pipe(
		Stream.takeUntil((event) => event.type === "turn.completed"),
		Stream.runCollect,
		Effect.map((events) =>
			events.filter(
				(event): event is Extract<AgentEvent, { type: "turn.completed" }> => event.type === "turn.completed",
			),
		),
	);

const stalledMessage =
	"The agent sent nothing for 200ms, so Octopus stopped the turn. Send your message again to retry.";

describe("makeAgentSession turn watchdog", () => {
	test("stops a turn that sends nothing and fails it with a clear error", async () => {
		let interrupts = 0;
		const results = await runQuietAgent(
			(session) =>
				Effect.gen(function* () {
					interrupts++;
					yield* session.emit({ type: "turn.completed", turnId: "turn-1", result: { status: "interrupted" } });
				}),
			(handle) => handle.sendMessage(userMessage("hi")).pipe(Effect.andThen(turnResults(handle))),
		);
		expect(interrupts).toBe(1);
		expect(results).toEqual([
			{ type: "turn.completed", turnId: "turn-1", result: { status: "failed", message: stalledMessage } },
		]);
	});

	test("ends the turn itself when the agent ignores the interrupt, then ends the session", async () => {
		const events = await runQuietAgent(
			() => Effect.void,
			// Collects until the session ends, so a late end of the stopped turn can never complete a later one.
			(handle) => handle.sendMessage(userMessage("hi")).pipe(Effect.andThen(Stream.runCollect(handle.events))),
		);
		expect(events.at(-1)).toEqual({
			type: "turn.completed",
			turnId: expect.stringMatching(/^octopus-/),
			result: { status: "failed", message: stalledMessage },
		});
	});

	test("each turn that fails to start gets its own id, so one notice never replaces another", async () => {
		const results = await Effect.gen(function* () {
			const session = yield* makeAgentSession(capabilities);
			const handle: AgentSessionHandle = yield* session.start({
				startTurn: () => Effect.fail(new AgentProtocolError({ message: "rejected", cause: null })),
				steerTurn: () => Effect.succeed(true),
				interruptTurn: Effect.void,
				updateSettings: () => Effect.void,
				listCommands: Effect.succeed([]),
			});
			yield* handle.sendMessage(userMessage("one"));
			yield* handle.sendMessage(userMessage("two"));
			return yield* handle.events.pipe(
				Stream.filter((event) => event.type === "turn.completed"),
				Stream.take(2),
				Stream.runCollect,
			);
		}).pipe(Effect.scoped, Effect.runPromise);
		const ids = results.map((event) => (event.type === "turn.completed" ? event.turnId : ""));
		expect(new Set(ids).size).toBe(2);
	});

	test("keeps a turn that is still sending events, or waiting on the user", async () => {
		const results = await runQuietAgent(
			() => Effect.die("the watchdog should not interrupt"),
			(handle, session) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("hi"));
					for (let index = 0; index < 4; index++) {
						yield* Effect.sleep("100 millis");
						yield* session.emit({ type: "message.delta", itemId: "msg-1", text: "." });
					}
					yield* session.requestApproval(
						{
							requestId: "approval-1",
							itemId: "cmd-1",
							kind: "command",
							summary: "bun test",
							reason: null,
							choices: ["allowOnce", "deny"],
						},
						() => Effect.void,
					);
					yield* Effect.sleep("500 millis");
					yield* handle.respondToApproval("approval-1", "allowOnce");
					yield* session.emit({ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } });
					return yield* turnResults(handle);
				}),
		);
		expect(results).toEqual([{ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } }]);
	});

	test("agent activity it does not show still keeps the turn alive", async () => {
		const results = await runQuietAgent(
			() => Effect.die("the watchdog should not interrupt"),
			(handle, session) =>
				Effect.gen(function* () {
					yield* handle.sendMessage(userMessage("hi"));
					for (let index = 0; index < 4; index++) {
						yield* Effect.sleep("100 millis");
						yield* session.touch;
					}
					yield* session.emit({ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } });
					return yield* turnResults(handle);
				}),
		);
		expect(results).toEqual([{ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } }]);
	});
});

test("a message sent after the session ended fails instead of being lost", async () => {
	const error = await runQuietAgent(
		() => Effect.void,
		(handle, session) => session.end.pipe(Effect.andThen(Effect.flip(handle.sendMessage(userMessage("late"))))),
	);
	expect(error._tag).toBe("AgentProcessError");
});

test("runs a queued message's beforeTurn only once the turn ahead of it has ended", async () => {
	const steps: Array<string> = [];
	await Effect.gen(function* () {
		const session = yield* makeAgentSession(capabilities);
		const handle: AgentSessionHandle = yield* session.start({
			startTurn: (message) => Effect.sync(() => void steps.push(`start ${message.text}`)),
			steerTurn: () => Effect.succeed(true),
			interruptTurn: Effect.void,
			updateSettings: () => Effect.void,
			listCommands: Effect.succeed([]),
		});
		const beforeTurn = (text: string) => Effect.sync(() => void steps.push(`before ${text}`));
		yield* handle.sendMessage(userMessage("one"), { beforeTurn: beforeTurn("one") });
		yield* handle.sendMessage(userMessage("two"), { beforeTurn: beforeTurn("two") });
		yield* Effect.sleep("50 millis");
		steps.push("end one");
		yield* session.emit({ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } });
		yield* Effect.sleep("50 millis");
	}).pipe(Effect.scoped, Effect.runPromise);
	expect(steps).toEqual(["before one", "start one", "end one", "before two", "start two"]);
});

describe("makeAgentSession plans", () => {
	const plan = { requestId: "plan-1", itemId: "plan-1", text: "1. Add tests", choices: ["auto", "ask"] } as const;

	const proposed = (session: AgentSession, answers: Array<PlanOutcome>) =>
		session.proposePlan(plan, (outcome) =>
			Effect.sync(() => {
				answers.push(outcome);
				return outcome.type === "approve" ? Option.some("Implement the plan.") : Option.none();
			}),
		);

	const planEvents = (handle: AgentSessionHandle, count: number) =>
		handle.events.pipe(
			Stream.filter((event) => event.type === "plan.proposed" || event.type === "plan.resolved"),
			Stream.take(count),
			Stream.runCollect,
		);

	test("answers a plan once, returns the agent's next message, and refuses a mode it did not offer", async () => {
		const answers: Array<PlanOutcome> = [];
		const result = await runQuietAgent(
			() => Effect.void,
			(handle, session) =>
				Effect.gen(function* () {
					yield* proposed(session, answers);
					const refused = yield* handle
						.respondToPlan("plan-1", { type: "approve", mode: "fullAccess" })
						.pipe(Effect.flip);
					const next = yield* handle.respondToPlan("plan-1", { type: "approve", mode: "auto" });
					const again = yield* handle.respondToPlan("plan-1", { type: "approve", mode: "auto" }).pipe(Effect.flip);
					return { refused: refused._tag, next, again: again._tag, events: yield* planEvents(handle, 2) };
				}),
		);
		expect(result.refused).toBe("ApprovalChoiceError");
		expect(result.next).toEqual(Option.some("Implement the plan."));
		expect(result.again).toBe("PlanNotFoundError");
		expect(answers).toEqual([{ type: "approve", mode: "auto" }]);
		expect(result.events.map((event) => event.type)).toEqual(["plan.proposed", "plan.resolved"]);
	});

	test("a new message or a stop cancels a waiting plan", async () => {
		const answers: Array<PlanOutcome> = [];
		const events = await runQuietAgent(
			(session) => session.emit({ type: "turn.completed", turnId: "turn-1", result: { status: "interrupted" } }),
			(handle, session) =>
				Effect.gen(function* () {
					yield* proposed(session, answers);
					yield* handle.sendMessage(userMessage("actually, use a queue"));
					yield* proposed(session, answers);
					yield* handle.interrupt;
					return yield* planEvents(handle, 4);
				}),
		);
		expect(answers).toEqual([{ type: "cancelled" }, { type: "cancelled" }]);
		expect(events.filter((event) => event.type === "plan.resolved")).toEqual([
			{ type: "plan.resolved", requestId: "plan-1", outcome: { type: "cancelled" } },
			{ type: "plan.resolved", requestId: "plan-1", outcome: { type: "cancelled" } },
		]);
	});
});

describe("makeAgentSession questions", () => {
	const request = {
		requestId: "q-1",
		itemId: "q-1",
		questions: [
			{ id: "db", header: "DB", question: "Which?", options: [], multiSelect: false, allowsOther: true, secret: false },
			{ id: "key", header: "Key", question: "Key?", options: [], multiSelect: false, allowsOther: true, secret: true },
		],
	};

	const questionEvents = (handle: AgentSessionHandle, count: number) =>
		handle.events.pipe(
			Stream.filter((event) => event.type === "question.asked" || event.type === "question.resolved"),
			Stream.take(count),
			Stream.runCollect,
		);

	test("passes every answer to the agent once, and stores none for a secret question", async () => {
		const outcomes: Array<QuestionOutcome> = [];
		const result = await runQuietAgent(
			() => Effect.void,
			(handle, session) =>
				Effect.gen(function* () {
					yield* session.askQuestions(request, (outcome) => Effect.sync(() => void outcomes.push(outcome)));
					yield* handle.answerQuestion("q-1", { db: ["SQLite"], key: ["s3cret"] });
					const again = yield* handle.answerQuestion("q-1", { db: ["SQLite"] }).pipe(Effect.flip);
					return { again: again._tag, events: yield* questionEvents(handle, 2) };
				}),
		);
		expect(outcomes).toEqual([{ type: "answered", answers: { db: ["SQLite"], key: ["s3cret"] } }]);
		expect(result.again).toBe("QuestionNotFoundError");
		expect(result.events.at(-1)).toEqual({
			type: "question.resolved",
			requestId: "q-1",
			outcome: { type: "answered", answers: { db: ["SQLite"] } },
		});
	});

	test("a new message or a stop cancels waiting questions", async () => {
		const outcomes: Array<QuestionOutcome> = [];
		await runQuietAgent(
			(session) => session.emit({ type: "turn.completed", turnId: "turn-1", result: { status: "interrupted" } }),
			(handle, session) =>
				Effect.gen(function* () {
					const ask = session.askQuestions(request, (outcome) => Effect.sync(() => void outcomes.push(outcome)));
					yield* ask;
					yield* handle.sendMessage(userMessage("never mind"));
					yield* ask;
					yield* handle.interrupt;
					return yield* questionEvents(handle, 4);
				}),
		);
		expect(outcomes).toEqual([{ type: "cancelled" }, { type: "cancelled" }]);
	});
});
