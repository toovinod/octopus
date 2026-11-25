import { type AgentSession, makeAgentSession, TurnWatchdogSettings } from "./makeAgentSession.ts";
import type { AgentEvent, PlanOutcome } from "@repo/contracts/AgentEvent";
import type { AgentSessionHandle } from "./AgentAdapter.ts";
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
			steerTurn: () => Effect.void,
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

	test("ends the turn itself when the agent ignores the interrupt", async () => {
		const results = await runQuietAgent(
			() => Effect.void,
			(handle) => handle.sendMessage(userMessage("hi")).pipe(Effect.andThen(turnResults(handle))),
		);
		expect(results).toEqual([
			{ type: "turn.completed", turnId: "notCompleted", result: { status: "failed", message: stalledMessage } },
		]);
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
