import { type AgentSession, makeAgentSession, TurnWatchdogSettings } from "./makeAgentSession.ts";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import type { AgentSessionHandle } from "./AgentAdapter.ts";
import { userMessage } from "../testing/userMessage.ts";
import { describe, expect, test } from "bun:test";
import { Duration, Effect, Stream } from "effect";

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
