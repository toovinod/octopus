import { applyEvents, emptyChat, prependEvents } from "./chatReducer.ts";
import type { AgentEvent } from "@repo/contracts/AgentEvent";
import { describe, expect, test } from "bun:test";

let nextSequence = 0;
const stored = (event: AgentEvent) => ({ sessionId: "s", sequence: nextSequence++, event, createdAt: "" });
const live = (event: AgentEvent) => ({ sessionId: "s", sequence: null, event, createdAt: "" });

const command = { kind: "command", command: "bun test", cwd: "/repo" } as const;

describe("applyEvents", () => {
	test("streams a reply, runs a tool behind an approval and records usage", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			stored({ type: "user.message", itemId: "u1", text: "Run the tests", attachments: [] }),
			live({ type: "message.delta", itemId: "m1", text: "Running " }),
			live({ type: "message.delta", itemId: "m1", text: "the tests." }),
			stored({ type: "tool.started", itemId: "c1", tool: command }),
			stored({
				type: "approval.requested",
				requestId: "r1",
				itemId: "c1",
				kind: "command",
				summary: "bun test",
				reason: null,
				choices: ["allowOnce", "deny"],
			}),
			stored({ type: "usage.updated", contextTokens: 1200, contextWindow: 200_000 }),
		]);
		expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "approval"]);
		expect(state.items[1]).toMatchObject({ text: "Running the tests.", streaming: true });
		expect(state.usage).toEqual({ contextTokens: 1200, contextWindow: 200_000 });

		const done = applyEvents(state, [
			stored({ type: "approval.resolved", requestId: "r1", outcome: "allowOnce" }),
			stored({ type: "tool.completed", itemId: "c1", tool: command, status: "completed", output: "3 pass" }),
			stored({ type: "turn.completed", turnId: "t1", result: { status: "completed" } }),
		]);
		expect(done.items[1]).toMatchObject({ streaming: false });
		expect(done.items[2]).toMatchObject({ kind: "tool", status: "completed", output: "3 pass" });
		expect(done.items[3]).toMatchObject({ kind: "approval", outcome: "allowOnce" });
		expect(done.lastSequence).toBe(6);
	});

	test("streams thinking into its own item above the reply and stores the completed text", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			live({ type: "reasoning.delta", itemId: "m1:0", text: "Split " }),
			live({ type: "reasoning.delta", itemId: "m1:0", text: "it up." }),
			live({ type: "message.delta", itemId: "m1:1", text: "391" }),
		]);
		expect(state.items).toEqual([
			{ kind: "reasoning", key: "reasoning:m1:0", text: "Split it up.", streaming: true },
			{ kind: "assistant", key: "message:m1:1", text: "391", streaming: true },
		]);
		const done = applyEvents(state, [
			stored({ type: "reasoning.completed", itemId: "m1:0", text: "Split it up." }),
			stored({ type: "turn.completed", turnId: "t1", result: { status: "completed" } }),
		]);
		expect(done.items).toEqual([
			{ kind: "reasoning", key: "reasoning:m1:0", text: "Split it up.", streaming: false },
			{ kind: "assistant", key: "message:m1:1", text: "391", streaming: false },
		]);
	});

	test("a snapshot of the text so far replaces what the chat holds, and later deltas add to it", () => {
		nextSequence = 0;
		// The chat saw the start of the reply, then lost its connection while more streamed.
		const before = applyEvents(emptyChat("s"), [
			live({ type: "reasoning.delta", itemId: "r1", text: "Thi" }),
			live({ type: "message.delta", itemId: "m1", text: "Hel" }),
		]);
		const state = applyEvents(before, [
			live({ type: "reasoning.delta", itemId: "r1", text: "Think", snapshot: true }),
			live({ type: "message.delta", itemId: "m1", text: "Hello", snapshot: true }),
			live({ type: "message.delta", itemId: "m1", text: "!" }),
		]);
		expect(state.items).toEqual([
			{ kind: "reasoning", key: "reasoning:r1", text: "Think", streaming: true },
			{ kind: "assistant", key: "message:m1", text: "Hello!", streaming: true },
		]);
	});

	test("a snapshot or delta that arrives after its item completed leaves the completed text", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			stored({ type: "message.completed", itemId: "m1", text: "Hello!" }),
			live({ type: "message.delta", itemId: "m1", text: "Hello", snapshot: true }),
			live({ type: "message.delta", itemId: "m1", text: "!" }),
		]);
		expect(state.items).toEqual([{ kind: "assistant", key: "message:m1", text: "Hello!", streaming: false }]);
	});

	test("a turn that ends before thinking completes stops it streaming", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			live({ type: "reasoning.delta", itemId: "r1", text: "Hmm" }),
			stored({ type: "turn.completed", turnId: "t1", result: { status: "interrupted" } }),
		]);
		expect(state.items[0]).toMatchObject({ kind: "reasoning", text: "Hmm", streaming: false });
	});

	test("history alone shows the stored thinking", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			stored({ type: "reasoning.completed", itemId: "r1", text: "Plan" }),
			stored({ type: "message.completed", itemId: "m1", text: "Done" }),
		]);
		expect(state.items.map((item) => item.key)).toEqual(["reasoning:r1", "message:m1"]);
	});

	test("skips stored events it already holds after a resubscribe", () => {
		nextSequence = 0;
		const first = stored({ type: "message.completed", itemId: "m1", text: "Hi" });
		const state = applyEvents(emptyChat("s"), [first]);
		expect(applyEvents(state, [first]).items).toHaveLength(1);
	});

	test("shows interrupted and failed turns as notices", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [
			stored({ type: "turn.completed", turnId: "t1", result: { status: "interrupted" } }),
			stored({ type: "turn.completed", turnId: "t2", result: { status: "failed", message: "Out of credits" } }),
			stored({
				type: "rateLimit.updated",
				window: "5h",
				status: "warning",
				usedPercent: 80,
				resetsAt: null,
			}),
		]);
		expect(state.items).toEqual([
			{ kind: "notice", key: "turn:t1", tone: "warning", text: "Interrupted" },
			{ kind: "notice", key: "turn:t2", tone: "error", text: "Out of credits" },
		]);
		expect(state.rateLimit).toMatchObject({ status: "warning", usedPercent: 80 });
	});
});

describe("applyEvents positions", () => {
	test("reuses the positions map when a batch only updates existing items", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [live({ type: "message.delta", itemId: "m1", text: "Hel" })]);
		const next = applyEvents(state, [live({ type: "message.delta", itemId: "m1", text: "lo" })]);
		expect(next.positions).toBe(state.positions);
		expect(next.items[0]).toMatchObject({ text: "Hello" });
	});

	test("adds new items without changing the previous state's positions", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [live({ type: "message.delta", itemId: "m1", text: "Hi" })]);
		const next = applyEvents(state, [
			stored({ type: "tool.started", itemId: "c1", tool: command }),
			stored({ type: "tool.started", itemId: "c2", tool: command }),
		]);
		expect(state.positions).toEqual({ "message:m1": 0 });
		expect(next.positions).toEqual({ "message:m1": 0, "tool:c1": 1, "tool:c2": 2 });
	});
});

describe("prependEvents", () => {
	test("joins an older page so items split across the boundary show once, in their older place", () => {
		nextSequence = 0;
		const older = [
			stored({ type: "user.message", itemId: "u1", text: "Run the tests", attachments: [] }),
			stored({ type: "tool.started", itemId: "c1", tool: command }),
			stored({
				type: "approval.requested",
				requestId: "r1",
				itemId: "c1",
				kind: "command",
				summary: "bun test",
				reason: null,
				choices: ["allowOnce", "deny"],
			}),
		];
		const newer = applyEvents(emptyChat("s"), [
			stored({ type: "approval.resolved", requestId: "r1", outcome: "allowOnce" }),
			stored({ type: "tool.completed", itemId: "c1", tool: command, status: "completed", output: "3 pass" }),
			stored({ type: "message.completed", itemId: "m1", text: "Done" }),
		]);
		expect(newer.firstSequence).toBe(3);
		expect(newer.earlierOutcomes).toEqual({ r1: "allowOnce" });

		const joined = prependEvents(newer, older);
		expect(joined.items.map((item) => item.key)).toEqual(["user:u1", "tool:c1", "approval:r1", "message:m1"]);
		expect(joined.items[1]).toMatchObject({ status: "completed", output: "3 pass" });
		expect(joined.items[2]).toMatchObject({ outcome: "allowOnce" });
		expect(joined.positions).toEqual({ "user:u1": 0, "tool:c1": 1, "approval:r1": 2, "message:m1": 3 });
		expect(joined.firstSequence).toBe(0);
		expect(joined.lastSequence).toBe(5);
		expect(joined.earlierOutcomes).toEqual({});
	});

	test("keeps an answer whose request is older still", () => {
		nextSequence = 5;
		const newer = applyEvents(emptyChat("s"), [
			stored({ type: "approval.resolved", requestId: "r0", outcome: "deny" }),
		]);
		nextSequence = 3;
		const joined = prependEvents(newer, [stored({ type: "message.completed", itemId: "m1", text: "Hi" })]);
		expect(joined.firstSequence).toBe(3);
		expect(joined.earlierOutcomes).toEqual({ r0: "deny" });
	});
});

describe("plans", () => {
	const proposed = (requestId: string) =>
		stored({ type: "plan.proposed", requestId, itemId: "p1", text: "1. Do it", choices: ["auto", "ask"] });

	test("shows a proposed plan and its answer", () => {
		nextSequence = 0;
		const state = applyEvents(emptyChat("s"), [proposed("r1")]);
		expect(state.items).toEqual([
			{ kind: "plan", key: "plan:r1", requestId: "r1", text: "1. Do it", choices: ["auto", "ask"], outcome: null },
		]);
		const done = applyEvents(state, [
			stored({ type: "plan.resolved", requestId: "r1", outcome: { type: "approve", mode: "auto" } }),
		]);
		expect(done.items[0]).toMatchObject({ outcome: { type: "approve", mode: "auto" } });
	});

	test("an answer in a newer page reaches the plan in an older page", () => {
		nextSequence = 1;
		const newer = applyEvents(emptyChat("s"), [
			stored({ type: "plan.resolved", requestId: "r1", outcome: { type: "revise", feedback: "Smaller" } }),
		]);
		expect(newer.earlierPlanOutcomes).toEqual({ r1: { type: "revise", feedback: "Smaller" } });
		nextSequence = 0;
		const joined = prependEvents(newer, [proposed("r1")]);
		expect(joined.items[0]).toMatchObject({ kind: "plan", outcome: { type: "revise", feedback: "Smaller" } });
		expect(joined.earlierPlanOutcomes).toEqual({});
	});
});

describe("questions", () => {
	const question = {
		id: "q0",
		header: "DB",
		question: "Which database?",
		options: [{ label: "SQLite", description: "Local file" }],
		multiSelect: false,
		allowsOther: true,
		secret: false,
	};

	test("shows asked questions and their answers, also across a page boundary", () => {
		nextSequence = 1;
		const newer = applyEvents(emptyChat("s"), [
			stored({
				type: "question.resolved",
				requestId: "r1",
				outcome: { type: "answered", answers: { q0: ["SQLite"] } },
			}),
		]);
		expect(newer.earlierQuestionOutcomes).toEqual({ r1: { type: "answered", answers: { q0: ["SQLite"] } } });
		nextSequence = 0;
		const joined = prependEvents(newer, [
			stored({ type: "question.asked", requestId: "r1", itemId: "r1", questions: [question] }),
		]);
		expect(joined.items).toEqual([
			{
				kind: "question",
				key: "question:r1",
				requestId: "r1",
				questions: [question],
				outcome: { type: "answered", answers: { q0: ["SQLite"] } },
			},
		]);
		expect(joined.earlierQuestionOutcomes).toEqual({});
	});
});
