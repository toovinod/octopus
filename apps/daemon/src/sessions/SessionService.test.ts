import {
	type AgentAdapter,
	AgentAuthError,
	AgentNotInstalledError,
	AgentProtocolError,
	type StartSessionInput,
} from "../agents/AgentAdapter.ts";
import {
	Deferred,
	Duration,
	Effect,
	Fiber,
	FileSystem,
	Layer,
	Logger,
	Queue,
	Redacted,
	Schedule,
	Schema,
	Stream,
} from "effect";
import {
	commandWithApproval,
	TEST_CLAUDE_LOGIN_URL,
	TEST_LOGIN_URL,
	testAgentServices,
} from "../testing/testAgentServices.ts";
import { runInTempDir, runServiceTest, type Services, withServices } from "../testing/runServiceTest.ts";
import type { AgentSessionStatus, AgentKind, AgentMode } from "@repo/contracts/AgentSession";
import { makeReplayAdapter, type Recording } from "../agents/replay/ReplayAdapter.ts";
import { CredentialStore, CredentialStoreError } from "../agents/CredentialStore.ts";
import { DATABASE_FILE_NAME, LocalDatabase } from "../database/LocalDatabase.ts";
import { makeTestRepository } from "../testing/makeTestRepository.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { agentSession, sessionEvent } from "../database/schema.ts";
import { makeAgentSession } from "../agents/makeAgentSession.ts";
import type { SessionEvent } from "@repo/contracts/SessionEvent";
import { ProjectService } from "../projects/ProjectService.ts";
import { AgentProbeSettings } from "./AgentProbeSettings.ts";
import { AgentEvent } from "@repo/contracts/AgentEvent";
import { SessionService } from "./SessionService.ts";
import { describe, expect, test } from "bun:test";
import { TestClock } from "effect/testing";
import { runGit } from "../git/runGit.ts";
import { asc, eq } from "drizzle-orm";
import { join } from "node:path";

const addWorkspace = Effect.fn("addWorkspace")(function* (tempDir: string) {
	const path = yield* makeTestRepository(join(tempDir, "repo"));
	const project = yield* Effect.flatMap(ProjectService, (projects) => projects.add(path));
	return yield* Effect.flatMap(WorkspaceService, (workspaces) =>
		workspaces.create({ kind: "inPlace", projectId: project.id }),
	);
});

const addSession = Effect.fn("addSession")(function* (tempDir: string, agent: AgentKind = "codex") {
	const workspace = yield* addWorkspace(tempDir);
	const sessions = yield* SessionService;
	return yield* sessions.create({ workspaceId: workspace.id, agent, model: "replay", effort: null });
});

const statusOf = (sessionId: string) =>
	Effect.flatMap(LocalDatabase, (database) =>
		database.query((db) => db.select().from(agentSession).where(eq(agentSession.id, sessionId))),
	).pipe(Effect.map(([row]) => row?.status));

const waitForStatus = (sessionId: string, status: AgentSessionStatus) =>
	statusOf(sessionId).pipe(
		Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (current) => current === status }),
		Effect.timeout("5 seconds"),
	);

const eventsUntil = (sessionId: string, afterSequence: number, type: AgentEvent["type"]) =>
	Effect.flatMap(SessionService, (sessions) =>
		sessions.subscribe(sessionId, afterSequence).pipe(
			Stream.takeUntil((stored) => stored.event.type === type),
			Stream.runCollect,
		),
	).pipe(Effect.timeout("5 seconds"));

const storedEvents = (sessionId: string) =>
	Effect.flatMap(LocalDatabase, (database) =>
		database.query((db) =>
			db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, sessionId)).orderBy(asc(sessionEvent.sequence)),
		),
	);

// A fresh session is already idle, so a finished turn is detected by its stored events instead.
const waitForStored = (sessionId: string, count: number) =>
	storedEvents(sessionId).pipe(
		Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (rows) => rows.length >= count }),
		Effect.timeout("10 seconds"),
	);

// Records every startSession input, so tests can check what the service passed to the agent.
const spyOn = (adapter: AgentAdapter) => {
	const inputs: Array<StartSessionInput> = [];
	const spy: AgentAdapter = {
		...adapter,
		startSession: (input) => {
			inputs.push(input);
			return adapter.startSession(input);
		},
	};
	return { inputs, spy };
};

const messages = (turnId: string, count: number): Array<AgentEvent> => [
	...Array.from(
		{ length: count },
		(_, index): AgentEvent => ({
			type: "message.completed",
			itemId: `${turnId}-${index}`,
			text: "ok",
		}),
	),
	{ type: "turn.completed", turnId, result: { status: "completed" } },
];

const runWithRecording = <A, E>(recording: Recording, program: (tempDir: string) => Effect.Effect<A, E, Services>) =>
	runInTempDir((tempDir) =>
		withServices(
			join(tempDir, "data"),
			testAgentServices({
				claude: makeReplayAdapter({ ...recording, kind: "claude" }),
				codex: makeReplayAdapter(recording),
			}),
		)(program(tempDir)),
	);

const sequences = (events: ReadonlyArray<SessionEvent>) => events.map((stored) => stored.sequence);

describe("SessionService", () => {
	test("creates idle sessions of both agents in one workspace", async () => {
		const sessions = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const workspace = yield* addWorkspace(tempDir);
				const service = yield* SessionService;
				yield* service.create({ workspaceId: workspace.id, agent: "claude", model: "claude-opus-5-5", effort: null });
				yield* service.create({ workspaceId: workspace.id, agent: "codex", model: "gpt-first", effort: null });
				yield* service.create({ workspaceId: workspace.id, agent: "codex", model: "gpt-first", effort: null });
				return yield* service.list(workspace.id);
			}),
		);
		expect(sessions.map((session) => [session.agent, session.status, session.authMode])).toEqual([
			["claude", "idle", "subscription"],
			["codex", "idle", "subscription"],
			["codex", "idle", "subscription"],
		]);
	});

	test("stores events with gapless sequences and keeps deltas live only", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const live = yield* eventsUntil(session.id, -1, "turn.completed").pipe(Effect.forkChild);
				// Let the subscription register before the turn starts.
				yield* Effect.sleep("100 millis");
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* sessions.respondToApproval(session.id, "0", "allowOnce");
				const received = yield* Fiber.join(live);
				yield* waitForStatus(session.id, "idle");
				const [row] = yield* sessions.list(session.workspaceId);
				return { received, stored: yield* storedEvents(session.id), row };
			}),
		);
		expect(result.received.map((stored) => [stored.event.type, stored.sequence])).toEqual([
			["session.started", 0],
			["user.message", 1],
			["message.delta", null],
			["message.delta", null],
			["message.completed", 2],
			["tool.started", 3],
			["approval.requested", 4],
			["approval.resolved", 5],
			["tool.completed", 6],
			["turn.completed", 7],
		]);
		expect(result.stored.map((row) => row.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(result.stored.some((row) => row.type === "message.delta")).toBe(false);
		expect(result.row?.nativeSessionId).toBe("thread-replay");
	});

	test("publishes reasoning deltas live and stores only the completed reasoning", async () => {
		const recording: Recording = {
			kind: "codex",
			nativeSessionId: "thread-thinking",
			turns: [
				[
					{ type: "reasoning.delta", itemId: "r1", text: "Plan" },
					{ type: "reasoning.delta", itemId: "r1", text: " it" },
					{ type: "reasoning.completed", itemId: "r1", text: "Plan it" },
					{ type: "turn.completed", turnId: "t1", result: { status: "completed" } },
				],
			],
		};
		const result = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const live = yield* eventsUntil(session.id, -1, "turn.completed").pipe(Effect.forkChild);
				// Let the subscription register before the turn starts.
				yield* Effect.sleep("100 millis");
				yield* sessions.sendMessage(session.id, "think", [], false);
				const received = yield* Fiber.join(live);
				yield* waitForStatus(session.id, "idle");
				return { received, stored: yield* storedEvents(session.id) };
			}),
		);
		expect(result.received.map((stored) => [stored.event.type, stored.sequence])).toEqual([
			["session.started", 0],
			["user.message", 1],
			["reasoning.delta", null],
			["reasoning.delta", null],
			["reasoning.completed", 2],
			["turn.completed", 3],
		]);
		expect(result.stored.map((row) => row.type)).toEqual([
			"session.started",
			"user.message",
			"reasoning.completed",
			"turn.completed",
		]);
	});

	test("a cursor subscription has no gap or duplicate while events arrive during paging", async () => {
		const recording: Recording = {
			kind: "codex",
			nativeSessionId: "thread-many",
			turns: [messages("first", 450), messages("second", 450)],
		};
		const received = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "first", [], false);
				yield* waitForStored(session.id, 453);
				yield* sessions.sendMessage(session.id, "second", [], false);
				return yield* sessions.subscribe(session.id, 10).pipe(
					Stream.takeUntil((stored) => stored.event.type === "turn.completed" && stored.event.turnId === "second"),
					Stream.runCollect,
				);
			}),
		);
		// 1 session.started, then the user message and 451 agent events per turn, starting after the cursor at 10.
		expect(sequences(received)).toEqual(Array.from({ length: 1 + 452 * 2 - 11 }, (_, index) => index + 11));
	});

	test("pages stored history backwards, and a subscription after the latest page joins it", async () => {
		// session.started, the user message and 8 agent events: sequences 0 to 9.
		const recording: Recording = { kind: "codex", nativeSessionId: "thread-pages", turns: [messages("first", 7)] };
		const result = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const empty = yield* sessions.history(session.id, null, 4);
				yield* sessions.sendMessage(session.id, "first", [], false);
				yield* waitForStored(session.id, 10);
				const latest = yield* sessions.history(session.id, null, 4);
				const before = yield* sessions.history(session.id, 6, 4);
				const oldest = yield* sessions.history(session.id, 2, 4);
				const exact = yield* sessions.history(session.id, 10, 10);
				const first = yield* sessions.history(session.id, 0, 4);
				const missing = yield* Effect.flip(sessions.history("nope", null, 4));
				yield* sessions.sendMessage(session.id, "second", [], false);
				const joined = yield* sessions.subscribe(session.id, latest.at(-1)?.sequence ?? -1).pipe(
					Stream.takeUntil((stored) => stored.event.type === "turn.completed"),
					Stream.runCollect,
					Effect.timeout("5 seconds"),
				);
				return { empty, latest, before, oldest, exact, first, missing, joined };
			}),
		);
		expect(result.empty).toEqual([]);
		expect(sequences(result.latest)).toEqual([6, 7, 8, 9]);
		expect(sequences(result.before)).toEqual([2, 3, 4, 5]);
		expect(sequences(result.oldest)).toEqual([0, 1]);
		expect(sequences(result.exact)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(result.first).toEqual([]);
		expect(result.missing._tag).toBe("SessionNotFoundError");
		// The second message has no recorded turn, so it fails at once: its user message, then turn.completed.
		expect(sequences(result.joined)).toEqual([10, 11]);
	});

	test("a failed turn leaves the session failed, and the next message still runs", async () => {
		const recording: Recording = {
			kind: "codex",
			nativeSessionId: "thread-failed",
			turns: [
				[{ type: "turn.completed", turnId: "broken", result: { status: "failed", message: "Rate limited" } }],
				messages("retry", 1),
			],
		};
		const statuses = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "first", [], false);
				yield* waitForStatus(session.id, "failed");
				const afterFailure = yield* statusOf(session.id);
				yield* sessions.sendMessage(session.id, "again", [], false);
				yield* waitForStored(session.id, 6);
				yield* waitForStatus(session.id, "idle");
				return [afterFailure, yield* statusOf(session.id)];
			}),
		);
		expect(statuses).toEqual(["failed", "idle"]);
	});

	test("a subscriber that falls behind gets ResubscribeRequiredError with its last sequence", async () => {
		const recording: Recording = {
			kind: "codex",
			nativeSessionId: "thread-burst",
			turns: [messages("warm", 1), messages("burst", 1_500)],
		};
		const result = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "warm", [], false);
				yield* waitForStored(session.id, 3);
				const firstReceived = yield* Deferred.make<void>();
				const gate = yield* Deferred.make<void>();
				const received: Array<SessionEvent> = [];
				const subscriber = yield* sessions.subscribe(session.id, -1).pipe(
					Stream.runForEach((stored) =>
						Effect.gen(function* () {
							received.push(stored);
							yield* Deferred.succeed(firstReceived, undefined);
							yield* Deferred.await(gate);
						}),
					),
					Effect.flip,
					Effect.forkChild,
				);
				// A history event has arrived, so the live subscription is already registered.
				yield* Deferred.await(firstReceived);
				yield* sessions.sendMessage(session.id, "burst", [], false);
				yield* waitForStored(session.id, 1_504);
				// Rows are stored before they are published, so give the subscriber's buffer time to fill.
				yield* Effect.sleep("200 millis");
				yield* Deferred.succeed(gate, undefined);
				const error = yield* Fiber.join(subscriber);
				return { error, received };
			}),
		);
		expect(result.error._tag).toBe("ResubscribeRequiredError");
		expect(result.received.length).toBeLessThan(1_504);
		expect(result.error._tag === "ResubscribeRequiredError" && result.error.lastSequence).toBe(
			result.received.at(-1)?.sequence ?? -1,
		);
	});

	test("counts a subscriber's buffer in UTF-8 bytes, not characters", async () => {
		// 200 messages of 2,000 three-byte characters: 0.4 million characters, but 1.2 MB, over the 1 MB budget.
		const wide = "\u6f22".repeat(2_000);
		const burst: Array<AgentEvent> = [
			...Array.from(
				{ length: 200 },
				(_, index): AgentEvent => ({
					type: "message.completed",
					itemId: `wide-${index}`,
					text: wide,
				}),
			),
			{ type: "turn.completed", turnId: "burst", result: { status: "completed" } },
		];
		const recording: Recording = { kind: "codex", nativeSessionId: "thread-wide", turns: [messages("warm", 1), burst] };
		const outcome = await runWithRecording(recording, (tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "warm", [], false);
				yield* waitForStored(session.id, 3);
				const firstReceived = yield* Deferred.make<void>();
				const gate = yield* Deferred.make<void>();
				const subscriber = yield* sessions.subscribe(session.id, -1).pipe(
					Stream.takeUntil((stored) => stored.event.type === "turn.completed" && stored.event.turnId === "burst"),
					Stream.runForEach(() =>
						Effect.gen(function* () {
							yield* Deferred.succeed(firstReceived, undefined);
							yield* Deferred.await(gate);
						}),
					),
					Effect.result,
					Effect.forkChild,
				);
				yield* Deferred.await(firstReceived);
				yield* sessions.sendMessage(session.id, "burst", [], false);
				yield* waitForStored(session.id, 205);
				yield* Effect.sleep("200 millis");
				yield* Deferred.succeed(gate, undefined);
				return yield* Fiber.join(subscriber).pipe(Effect.timeout("5 seconds"));
			}),
		);
		expect(outcome._tag === "Failure" && outcome.failure._tag).toBe("ResubscribeRequiredError");
	});

	test("runs nine sessions concurrently while each waits for approval", async () => {
		const active = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const workspace = yield* addWorkspace(tempDir);
				const created = yield* Effect.forEach(Array.from({ length: 9 }), () =>
					sessions.create({ workspaceId: workspace.id, agent: "codex", model: "replay", effort: null }),
				);
				for (const session of created) {
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					yield* waitForStatus(session.id, "awaitingApproval");
				}
				return yield* sessions.list(workspace.id);
			}),
		);
		expect(active).toHaveLength(9);
		expect(active.every((session) => session.status === "awaitingApproval")).toBe(true);
	});

	test("watching starts with every session of the active workspaces, then follows changes", async () => {
		const titles = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const workspaces = yield* WorkspaceService;
				const session = yield* addSession(tempDir);
				const workspace = yield* workspaces.get(session.workspaceId);
				const old = yield* workspaces.create({ kind: "worktree", projectId: workspace.projectId, name: "old" });
				yield* sessions.create({ workspaceId: old.id, agent: "codex", model: "replay", effort: null });
				yield* workspaces.archive(old.id, { force: false });
				// Every session above changed before the watch began, so only its first items can report them.
				const watched = yield* sessions.watch.pipe(
					Stream.take(2),
					Stream.runCollect,
					Effect.timeout("5 seconds"),
					Effect.forkChild,
				);
				yield* Effect.sleep("100 millis");
				yield* sessions.rename(session.id, "Renamed");
				return (yield* Fiber.join(watched)).map((changed) => [changed.id === session.id, changed.title]);
			}),
		);
		expect(titles).toEqual([
			[true, null],
			[true, "Renamed"],
		]);
	});

	test("marks sessions cut off by a restart as interrupted", async () => {
		const statuses = await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const dataDir = join(tempDir, "data");
				const ids = yield* withServices(dataDir)(
					Effect.gen(function* () {
						const sessions = yield* SessionService;
						const database = yield* LocalDatabase;
						const workspace = yield* addWorkspace(tempDir);
						const ids = [];
						for (const status of ["running", "awaitingApproval", "idle"] as const) {
							const session = yield* sessions.create({
								workspaceId: workspace.id,
								agent: "codex",
								model: "replay",
								effort: null,
							});
							yield* database.query((db) =>
								db.update(agentSession).set({ status }).where(eq(agentSession.id, session.id)),
							);
							ids.push(session.id);
						}
						return ids;
					}),
				);
				return yield* withServices(dataDir)(Effect.forEach(ids, statusOf));
			}),
		);
		expect(statuses).toEqual(["interrupted", "interrupted", "idle"]);
	});

	test("moves through running, awaitingApproval, running and idle during an approved turn", async () => {
		const statuses = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const watched = yield* sessions.watch.pipe(
					Stream.filter((changed) => changed.id === session.id),
					Stream.map((changed) => changed.status),
					Stream.changes,
					Stream.dropWhile((status) => status === "idle"),
					Stream.takeUntil((status) => status === "idle"),
					Stream.runCollect,
					Effect.timeout("5 seconds"),
					Effect.forkChild,
				);
				yield* Effect.sleep("100 millis");
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* sessions.respondToApproval(session.id, "0", "allowOnce");
				return yield* Fiber.join(watched);
			}),
		);
		expect(statuses).toEqual(["running", "awaitingApproval", "running", "idle"]);
	});

	test("interrupt during an approval cancels it, then interrupts the turn", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* sessions.interrupt(session.id);
				const events = yield* eventsUntil(session.id, 4, "turn.completed");
				return {
					events: events.map((stored) => stored.event),
					status: yield* waitForStatus(session.id, "interrupted"),
				};
			}),
		);
		expect(result.events).toEqual([
			{ type: "approval.resolved", requestId: "0", outcome: "cancelled" },
			{ type: "turn.completed", turnId: "replay-0", result: { status: "interrupted" } },
		]);
		expect(result.status).toBe("interrupted");
	});

	test("stopSession ends the process and the next message resumes with the native id", async () => {
		const codex = spyOn(makeReplayAdapter(commandWithApproval));
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex: codex.spy }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const session = yield* addSession(tempDir);
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					yield* waitForStatus(session.id, "awaitingApproval");
					yield* sessions.stop(session.id);
					const afterStop = yield* statusOf(session.id);
					const events = yield* storedEvents(session.id);
					yield* sessions.sendMessage(session.id, "go on", [], false);
					yield* waitForStatus(session.id, "awaitingApproval");
					return { afterStop, lastType: events.at(-1)?.type, workspace: session.workspaceId };
				}),
			),
		);
		expect(result.afterStop).toBe("interrupted");
		expect(result.lastType).toBe("turn.completed");
		expect(codex.inputs.map((input) => input.resumeId)).toEqual([undefined, "thread-replay"]);
		expect(codex.inputs[0]).toMatchObject({
			model: "replay",
			trustProjectSettings: false,
			auth: { mode: "subscription" },
		});
	});

	test("releases an expired idle process and resumes it while a pending approval stays live", async () => {
		await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const released = yield* Deferred.make<void>();
				const replay = makeReplayAdapter(commandWithApproval);
				const codex = spyOn({
					...replay,
					startSession: (input) =>
						replay
							.startSession(input)
							.pipe(
								Effect.tap(() =>
									input.model === "idle"
										? Effect.addFinalizer(() => Deferred.succeed(released, undefined))
										: Effect.void,
								),
							),
				});
				yield* withServices(
					join(tempDir, "data"),
					testAgentServices({
						claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }),
						codex: codex.spy,
					}),
				)(
					Effect.gen(function* () {
						const sessions = yield* SessionService;
						const workspace = yield* addWorkspace(tempDir);
						const idle = yield* sessions.create({
							workspaceId: workspace.id,
							agent: "codex",
							model: "idle",
							effort: null,
						});
						const busy = yield* sessions.create({
							workspaceId: workspace.id,
							agent: "codex",
							model: "replay",
							effort: null,
						});
						for (const session of [idle, busy]) {
							yield* sessions.sendMessage(session.id, "run the tests", [], false);
							yield* TestClock.withLive(waitForStatus(session.id, "awaitingApproval"));
						}
						yield* TestClock.adjust("4 minutes");
						yield* sessions.respondToApproval(idle.id, "0", "allowOnce");
						yield* TestClock.withLive(waitForStatus(idle.id, "idle"));
						yield* TestClock.adjust("4 minutes");
						expect(yield* Deferred.isDone(released)).toBe(false);
						yield* TestClock.adjust("1 minute");
						yield* TestClock.withLive(Deferred.await(released).pipe(Effect.timeout("1 second")));
						expect(yield* statusOf(idle.id)).toBe("idle");
						yield* sessions.respondToApproval(busy.id, "0", "allowOnce");
						yield* sessions.sendMessage(idle.id, "run again", [], false);
						yield* TestClock.withLive(waitForStatus(idle.id, "awaitingApproval"));
						expect(codex.inputs.map((input) => input.resumeId)).toEqual([undefined, undefined, "thread-replay"]);
					}),
				);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	});

	test("archiving stops agents in parallel and leaves other workspaces responsive", async () => {
		await runInTempDir((tempDir) =>
			Effect.gen(function* () {
				const stopping = yield* Queue.unbounded<string>();
				const release = yield* Deferred.make<void>();
				const replay = makeReplayAdapter(commandWithApproval);
				const codex: AgentAdapter = {
					...replay,
					startSession: (input) =>
						replay.startSession(input).pipe(
							Effect.map((handle) => ({
								...handle,
								interrupt: Queue.offer(stopping, input.model).pipe(
									Effect.andThen(Deferred.await(release)),
									Effect.andThen(handle.interrupt),
								),
							})),
						),
				};
				yield* withServices(
					join(tempDir, "data"),
					testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
				)(
					Effect.gen(function* () {
						const sessions = yield* SessionService;
						const workspaces = yield* WorkspaceService;
						const workspace = yield* addWorkspace(tempDir);
						const otherWorkspace = yield* workspaces.create({
							kind: "worktree",
							projectId: workspace.projectId,
							name: "other",
						});
						for (const model of ["first", "second"]) {
							const session = yield* sessions.create({
								workspaceId: workspace.id,
								agent: "codex",
								model,
								effort: null,
							});
							yield* sessions.sendMessage(session.id, "run the tests", [], false);
							yield* waitForStatus(session.id, "awaitingApproval");
						}
						const other = yield* sessions.create({
							workspaceId: otherWorkspace.id,
							agent: "codex",
							model: "replay",
							effort: null,
						});
						const archiving = yield* workspaces.archive(workspace.id, { force: false }).pipe(Effect.forkChild);
						yield* Effect.gen(function* () {
							const models = [yield* Queue.take(stopping), yield* Queue.take(stopping)];
							expect(models.sort()).toEqual(["first", "second"]);
							yield* sessions.sendMessage(other.id, "run the tests", [], false);
							yield* waitForStatus(other.id, "awaitingApproval");
						}).pipe(Effect.timeout("2 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)));
						expect((yield* Fiber.join(archiving)).status).toBe("archived");
					}),
				);
			}),
		);
	});

	test("archiving a workspace stops its agent processes", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "run the tests", [], false);
				yield* waitForStatus(session.id, "awaitingApproval");
				yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.archive(session.workspaceId, { force: false }),
				);
				return {
					status: yield* statusOf(session.id),
					approval: yield* Effect.flip(sessions.respondToApproval(session.id, "0", "allowOnce")),
					message: yield* Effect.flip(sessions.sendMessage(session.id, "one more thing", [], false)),
				};
			}),
		);
		expect(result.status).toBe("interrupted");
		expect(result.approval._tag).toBe("ApprovalNotFoundError");
		expect(result.message._tag).toBe("WorkspaceArchivedError");
	});

	test("a forced archive keeps files an agent writes while it is being stopped", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		// An agent that saves one last file when it is interrupted, after the archive checked the folder.
		const codex: AgentAdapter = {
			...replay,
			startSession: (input) =>
				Effect.map(replay.startSession(input), (handle) => ({
					...handle,
					interrupt: Effect.promise(() => Bun.write(join(input.cwd, "late.txt"), "late")).pipe(
						Effect.andThen(handle.interrupt),
					),
				})),
		};
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const workspaces = yield* WorkspaceService;
					const inPlace = yield* addWorkspace(tempDir);
					const workspace = yield* workspaces.create({ kind: "worktree", projectId: inPlace.projectId, name: "late" });
					const session = yield* sessions.create({
						workspaceId: workspace.id,
						agent: "codex",
						model: "replay",
						effort: null,
					});
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					yield* waitForStatus(session.id, "awaitingApproval");
					const archived = yield* workspaces.archive(workspace.id, { force: true });
					const stashes = yield* runGit(join(tempDir, "repo"), ["stash", "list"]);
					return { status: archived.status, stashes };
				}),
			),
		);
		expect(result.status).toBe("archived");
		expect(result.stashes).toContain("octopus-archive/");
	});

	test("stores sent images privately, records only their ids, and deletes them on archive", async () => {
		const image = { mediaType: "image/png", base64: Buffer.from("png bytes").toString("base64") } as const;
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const fs = yield* FileSystem.FileSystem;
				const session = yield* addSession(tempDir);
				yield* sessions.sendMessage(session.id, "look", [image], false);
				const [, stored] = yield* waitForStored(session.id, 2);
				const event = Schema.decodeUnknownSync(AgentEvent)(stored?.payload);
				const attachmentId = event.type === "user.message" ? (event.attachments[0]?.id ?? "") : "";
				const path = join(tempDir, "data", "attachments", session.id, attachmentId);
				const mode = ((yield* fs.stat(path)).mode & 0o777).toString(8);
				const served = yield* sessions.getAttachment(session.id, attachmentId);
				const unknown = yield* Effect.flip(sessions.getAttachment(session.id, "../../octopus.db"));
				yield* Effect.flatMap(WorkspaceService, (workspaces) =>
					workspaces.archive(session.workspaceId, { force: false }),
				);
				return { event, mode, served, unknown, removed: !(yield* fs.exists(path)) };
			}),
		);
		expect(result.event).toMatchObject({
			type: "user.message",
			text: "look",
			attachments: [{ mediaType: "image/png" }],
		});
		expect(JSON.stringify(result.event)).not.toContain(image.base64);
		expect(result.mode).toBe("600");
		expect(result.served).toEqual(image);
		expect(result.unknown._tag).toBe("AttachmentNotFoundError");
		expect(result.removed).toBe(true);
	});

	test("keeps sent images when archiving the workspace fails", async () => {
		const image = { mediaType: "image/png", base64: Buffer.from("png bytes").toString("base64") } as const;
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const workspaces = yield* WorkspaceService;
				const path = yield* makeTestRepository(join(tempDir, "repo"));
				const project = yield* Effect.flatMap(ProjectService, (projects) => projects.add(path));
				const created = yield* workspaces.create({ kind: "worktree", projectId: project.id, name: "feature" });
				const session = yield* sessions.create({
					workspaceId: created.id,
					agent: "codex",
					model: "replay",
					effort: null,
				});
				yield* sessions.sendMessage(session.id, "look", [image], false);
				const [, stored] = yield* waitForStored(session.id, 2);
				const event = Schema.decodeUnknownSync(AgentEvent)(stored?.payload);
				const attachmentId = event.type === "user.message" ? (event.attachments[0]?.id ?? "") : "";
				// A locked worktree refuses `git worktree remove`, so the archive fails.
				yield* runGit(path, ["worktree", "lock", created.path]);
				const failed = yield* Effect.flip(workspaces.archive(created.id, { force: false }));
				return {
					failed,
					status: (yield* workspaces.get(created.id)).status,
					served: yield* sessions.getAttachment(session.id, attachmentId),
				};
			}),
		);
		expect(result.failed._tag).toBe("WorktreeRemoveError");
		expect(result.status).toBe("active");
		expect(result.served).toEqual(image);
	});

	test("a refused credential fails the session and says to fix the credential", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		const codex: AgentAdapter = {
			...replay,
			startSession: () =>
				Effect.gen(function* () {
					const session = yield* makeAgentSession(replay.capabilities);
					yield* session.setNativeSessionId("thread-auth");
					return yield* session.start({
						startTurn: () => session.fail(new AgentAuthError({ agent: "codex", cause: "401 Unauthorized" })),
						steerTurn: () => Effect.void,
						interruptTurn: Effect.void,
						updateSettings: () => Effect.void,
					});
				}),
		};
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const session = yield* addSession(tempDir);
					yield* sessions.sendMessage(session.id, "first", [], false);
					yield* waitForStatus(session.id, "failed");
					return (yield* storedEvents(session.id)).at(-1)?.payload;
				}),
			),
		);
		expect(result).toEqual({
			type: "error",
			message:
				"Codex refused its credential. Update the API key or sign in again in Settings, then send your message again.",
			willRetry: false,
		});
	});

	test("a steer the agent rejects leaves no message in history and no image on disk", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		// A turn that keeps running, so the next message steers, and an agent that rejects every steer.
		const codex: AgentAdapter = {
			...replay,
			capabilities: { ...replay.capabilities, steerWhileRunning: true },
			startSession: () =>
				Effect.gen(function* () {
					const session = yield* makeAgentSession({ ...replay.capabilities, steerWhileRunning: true });
					yield* session.setNativeSessionId("thread-steer");
					return yield* session.start({
						startTurn: () => session.emit({ type: "message.completed", itemId: "working", text: "working" }),
						steerTurn: () => Effect.fail(new AgentProtocolError({ message: "No active turn", cause: null })),
						interruptTurn: Effect.void,
						updateSettings: () => Effect.void,
					});
				}),
		};
		const image = { mediaType: "image/png", base64: Buffer.from("png bytes").toString("base64") } as const;
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const fs = yield* FileSystem.FileSystem;
					const session = yield* addSession(tempDir);
					yield* sessions.sendMessage(session.id, "first", [], false);
					yield* waitForStored(session.id, 3);
					const error = yield* Effect.flip(sessions.sendMessage(session.id, "steer", [image], true));
					// Give a wrongly recorded message time to reach the database.
					yield* Effect.sleep("100 millis");
					const directory = join(tempDir, "data", "attachments", session.id);
					return {
						error,
						types: (yield* storedEvents(session.id)).map((row) => row.type),
						files: (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [],
					};
				}),
			),
		);
		expect(result.error._tag).toBe("AgentUnavailableError");
		expect(result.types).toEqual(["session.started", "user.message", "message.completed"]);
		expect(result.files).toEqual([]);
	});

	test("a send cancelled before the agent takes it leaves the session idle and no image on disk", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		// An agent that never accepts the message, like a client that disconnects mid-send.
		const codex: AgentAdapter = {
			...replay,
			startSession: (input) =>
				Effect.map(replay.startSession(input), (handle) => ({ ...handle, sendMessage: () => Effect.never })),
		};
		const image = { mediaType: "image/png", base64: Buffer.from("png bytes").toString("base64") } as const;
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const fs = yield* FileSystem.FileSystem;
					const session = yield* addSession(tempDir);
					const send = yield* Effect.forkChild(sessions.sendMessage(session.id, "hello", [image], false));
					yield* waitForStatus(session.id, "running");
					yield* Fiber.interrupt(send);
					yield* waitForStatus(session.id, "idle");
					const directory = join(tempDir, "data", "attachments", session.id);
					return (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
				}),
			),
		);
		expect(result).toEqual([]);
	});

	test("refuses images for a model that cannot read them", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		const { models } = await Effect.runPromise(replay.listModels);
		const codex: AgentAdapter = {
			...replay,
			listModels: Effect.succeed({
				models: models.map((model) => ({ ...model, supportsImages: false })),
				defaultModel: "replay",
			}),
		};
		const error = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const session = yield* addSession(tempDir);
					const sessions = yield* SessionService;
					return yield* Effect.flip(
						sessions.sendMessage(session.id, "look", [{ mediaType: "image/png", base64: "aGk=" }], false),
					);
				}),
			),
		);
		expect(error._tag).toBe("ImagesNotSupportedError");
	});

	test("stores model and effort and hands changes to the running agent", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		const changes: Array<unknown> = [];
		const inputs: Array<StartSessionInput> = [];
		const codex: AgentAdapter = {
			...replay,
			startSession: (input) =>
				Effect.map(replay.startSession(input), (handle) => {
					inputs.push(input);
					return { ...handle, updateSettings: (settings) => Effect.sync(() => void changes.push(settings)) };
				}),
		};
		const updated = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const workspace = yield* addWorkspace(tempDir);
					const session = yield* sessions.create({
						workspaceId: workspace.id,
						agent: "codex",
						model: "replay",
						effort: "low",
					});
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					return yield* sessions.updateSettings(session.id, { model: "other", effort: "high", mode: "ask" });
				}),
			),
		);
		expect(inputs[0]).toMatchObject({ model: "replay", effort: "low" });
		expect(changes).toEqual([{ model: "other", effort: "high", mode: "ask" }]);
		expect(updated).toMatchObject({ model: "other", effort: "high" });
	});

	test("a session starts in its agent's default mode, and one stored without a mode reads as it", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				yield* Effect.flatMap(LocalDatabase, (database) =>
					database.query((db) => db.update(agentSession).set({ mode: null }).where(eq(agentSession.id, session.id))),
				);
				const [listed] = yield* sessions.list(session.workspaceId);
				return { session, listed };
			}),
		);
		expect(result.session.mode).toBe("ask");
		expect(result.listed?.mode).toBe("ask");
	});

	test("refuses a mode the agent does not offer, and full access until the project is trusted", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				const session = yield* addSession(tempDir);
				const settings = (mode: AgentMode) =>
					sessions.updateSettings(session.id, { model: "replay", effort: null, mode });
				const notOffered = yield* Effect.flip(settings("auto"));
				const untrusted = yield* Effect.flip(settings("fullAccess"));
				const workspace = yield* Effect.flatMap(WorkspaceService, (workspaces) => workspaces.get(session.workspaceId));
				yield* Effect.flatMap(ProjectService, (projects) => projects.setTrust(workspace.projectId, true));
				const trusted = yield* settings("fullAccess");
				return { notOffered, untrusted, trusted };
			}),
		);
		expect(result.notOffered).toMatchObject({ _tag: "ModeNotAllowedError", mode: "auto" });
		expect(result.untrusted).toMatchObject({ _tag: "ModeNotAllowedError", mode: "fullAccess" });
		expect(result.trusted.mode).toBe("fullAccess");
	});

	test("keeps the mode the agent switches to by itself", async () => {
		const codex = makeReplayAdapter({
			kind: "codex",
			nativeSessionId: "replay-mode",
			turns: [
				[
					{ type: "mode.changed", mode: "ask" },
					{ type: "turn.completed", turnId: "turn-1", result: { status: "completed" } },
				],
			],
		});
		const mode = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const session = yield* addSession(tempDir);
					yield* sessions.updateSettings(session.id, { model: "replay", effort: null, mode: "plan" });
					yield* sessions.sendMessage(session.id, "make a plan", [], false);
					yield* waitForStatus(session.id, "idle");
					const [listed] = yield* sessions.list(session.workspaceId);
					return listed?.mode;
				}),
			),
		);
		expect(mode).toBe("ask");
	});

	test("keeps the stored settings when the running agent refuses the change", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		const codex: AgentAdapter = {
			...replay,
			startSession: (input) =>
				Effect.map(replay.startSession(input), (handle) => ({
					...handle,
					updateSettings: () => Effect.fail(new AgentProtocolError({ message: "Unknown model", cause: null })),
				})),
		};
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const session = yield* addSession(tempDir);
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					const error = yield* Effect.flip(
						sessions.updateSettings(session.id, { model: "other", effort: "high", mode: "ask" }),
					);
					const [row] = yield* sessions.list(session.workspaceId);
					return { error, row };
				}),
			),
		);
		expect(result.error._tag).toBe("AgentProtocolError");
		expect(result.row).toMatchObject({ model: "replay", effort: null });
	});

	test("Claude in API key mode needs a key before it starts", async () => {
		const error = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				yield* sessions.setAuthMode("claude", "apiKey");
				const session = yield* addSession(tempDir, "claude");
				return yield* Effect.flip(sessions.sendMessage(session.id, "hi", [], false));
			}),
		);
		expect(error).toMatchObject({
			_tag: "AgentUnavailableError",
			agent: "claude",
			availability: { status: "needsApiKey" },
		});
	});

	test("lists agents with availability, capabilities and models", async () => {
		const [before, after] = await runServiceTest(() =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				yield* sessions.setAuthMode("claude", "apiKey");
				const before = yield* sessions.listAgents;
				yield* sessions.setApiKey("claude", Redacted.make("sk-ant-test"));
				return [before, yield* sessions.listAgents] as const;
			}),
		);
		expect(before.map((agent) => [agent.kind, agent.availability])).toEqual([
			["claude", { status: "needsApiKey" }],
			["codex", { status: "ready", account: null }],
		]);
		expect(after[0]?.availability).toEqual({ status: "ready", account: null });
		expect(after[1]).toMatchObject({ defaultModel: "replay", models: [{ id: "replay", label: "Replay" }] });
	});

	test("reports a missing CLI even when an API key is stored", async () => {
		const claude: AgentAdapter = {
			...makeReplayAdapter({ ...commandWithApproval, kind: "claude" }),
			checkAuth: Effect.fail(new AgentNotInstalledError({ executable: "claude" })),
		};
		const agents = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude, codex: makeReplayAdapter(commandWithApproval) }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					yield* sessions.setApiKey("claude", Redacted.make("sk-ant-test"));
					return yield* sessions.listAgents;
				}),
			),
		);
		expect(agents[0]?.availability).toEqual({ status: "notInstalled" });
	});

	test("lists both agents when the keychain cannot be read", async () => {
		const brokenKeychain = Layer.succeed(
			CredentialStore,
			CredentialStore.of({
				get: () => Effect.fail(new CredentialStoreError({ cause: "locked" })),
				set: () => Effect.void,
				remove: () => Effect.void,
			}),
		);
		const agents = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				Layer.merge(testAgentServices(), brokenKeychain),
			)(Effect.flatMap(SessionService, (sessions) => sessions.listAgents)),
		);
		expect(agents.map((agent) => [agent.kind, agent.availability.status])).toEqual([
			["claude", "unknown"],
			["codex", "unknown"],
		]);
	});

	test("an agent that never answers its probe is reported, not waited on", async () => {
		const claude: AgentAdapter = {
			...makeReplayAdapter({ ...commandWithApproval, kind: "claude" }),
			checkAuth: Effect.never,
		};
		const agents = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude, codex: makeReplayAdapter(commandWithApproval) }),
			)(
				Effect.flatMap(SessionService, (sessions) => sessions.listAgents).pipe(
					Effect.provideService(AgentProbeSettings, { timeout: Duration.millis(50) }),
				),
			),
		);
		expect(agents.map((agent) => [agent.kind, agent.availability.status])).toEqual([
			["claude", "unknown"],
			["codex", "ready"],
		]);
	});

	test("asks each agent for its models once per daemon run", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		let calls = 0;
		const codex: AgentAdapter = {
			...replay,
			listModels: Effect.andThen(
				Effect.sync(() => calls++),
				replay.listModels,
			),
		};
		await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(Effect.flatMap(SessionService, (sessions) => Effect.repeat(sessions.listAgents, { times: 2 }))),
		);
		expect(calls).toBe(1);
	});

	test("a finished Codex sign-in reaches watchers and fetches the models again", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		let calls = 0;
		const logins = Effect.runSync(Queue.unbounded<{ success: boolean; error: string | null }>());
		const codex = {
			...replay,
			listModels: Effect.andThen(
				Effect.sync(() => calls++),
				replay.listModels,
			),
			loginResults: Stream.fromQueue(logins),
		};
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					yield* sessions.listAgents;
					const watched = yield* sessions.watchLogins.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
					yield* Effect.sleep("20 millis");
					yield* Queue.offer(logins, { success: false, error: "The sign-in was cancelled." });
					yield* Queue.offer(logins, { success: true, error: null });
					const results = yield* Fiber.join(watched);
					yield* sessions.listAgents;
					return { results, calls };
				}),
			),
		);
		expect(result.results).toEqual([
			{ agent: "codex", success: false },
			{ agent: "codex", success: true },
		]);
		expect(result.calls).toBe(2);
	});

	test("asks for an agent's models again after its sign-in changes", async () => {
		const replay = makeReplayAdapter(commandWithApproval);
		let calls = 0;
		const codex: AgentAdapter = {
			...replay,
			listModels: Effect.andThen(
				Effect.sync(() => calls++),
				replay.listModels,
			),
		};
		const counts = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: makeReplayAdapter({ ...commandWithApproval, kind: "claude" }), codex }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const countAfter = <E>(change: Effect.Effect<void, E>) =>
						Effect.gen(function* () {
							yield* change;
							yield* sessions.listAgents;
							return calls;
						});
					return [
						yield* countAfter(Effect.void),
						yield* countAfter(sessions.setApiKey("codex", Redacted.make("sk-test"))),
						yield* countAfter(sessions.setAuthMode("codex", "apiKey")),
						yield* countAfter(sessions.removeApiKey("codex")),
						// Another agent's key leaves this agent's models alone.
						yield* countAfter(sessions.setApiKey("claude", Redacted.make("sk-ant-test"))),
					];
				}),
			),
		);
		expect(counts).toEqual([1, 2, 3, 4, 4]);
	});

	test("lets both agents switch between their sign-in modes and start their own sign-in", async () => {
		const result = await runServiceTest((tempDir) =>
			Effect.gen(function* () {
				const sessions = yield* SessionService;
				yield* sessions.setAuthMode("claude", "subscription");
				const claudeLogin = yield* sessions.startLogin("claude");
				const login = yield* sessions.startLogin("codex");
				const codeRefused = yield* Effect.flip(sessions.submitLoginCode("codex", "code"));
				yield* sessions.submitLoginCode("claude", "code");
				yield* sessions.setAuthMode("codex", "apiKey");
				const [claude, codex] = yield* sessions.listAgents;
				const session = yield* addSession(tempDir);
				const needsKey = yield* Effect.flip(sessions.sendMessage(session.id, "hi", [], false));
				return { claudeLogin, login, codeRefused, claude, codex, session, needsKey };
			}),
		);
		expect(result.claudeLogin.authUrl).toBe(TEST_CLAUDE_LOGIN_URL);
		expect(result.login.authUrl).toBe(TEST_LOGIN_URL);
		expect(result.codeRefused._tag).toBe("LoginNotPendingError");
		expect(result.claude).toMatchObject({ authModes: ["apiKey", "subscription"], authMode: "subscription" });
		expect(result.codex).toMatchObject({
			authModes: ["apiKey", "subscription"],
			authMode: "apiKey",
			availability: { status: "needsApiKey" },
		});
		expect(result.session.authMode).toBe("apiKey");
		expect(result.needsKey).toMatchObject({ _tag: "AgentUnavailableError", availability: { status: "needsApiKey" } });
	});

	test("reports how a Claude sign-in ended and fetches Claude's models again", async () => {
		const logins = await Effect.runPromise(Queue.unbounded<{ readonly success: boolean }>());
		const claude = {
			...makeReplayAdapter({ ...commandWithApproval, kind: "claude" }),
			startLogin: Effect.succeed(TEST_CLAUDE_LOGIN_URL),
			submitLoginCode: () => Effect.void,
			loginResults: Stream.fromQueue(logins),
		};
		const results = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude, codex: makeReplayAdapter(commandWithApproval) }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					const watched = yield* sessions.watchLogins.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
					yield* Effect.sleep("20 millis");
					yield* Queue.offer(logins, { success: true });
					return yield* Fiber.join(watched);
				}),
			),
		);
		expect(results).toEqual([{ agent: "claude", success: true }]);
	});

	test("the API key never reaches the database or the logs", async () => {
		const apiKey = "sk-ant-never-store-me-4f2a";
		const logs: Array<string> = [];
		const capture = Logger.make((options) => {
			logs.push(String(Logger.formatLogFmt.log(options)));
		});
		const claude = spyOn(makeReplayAdapter({ ...commandWithApproval, kind: "claude" }));
		const result = await runInTempDir((tempDir) =>
			withServices(
				join(tempDir, "data"),
				testAgentServices({ claude: claude.spy, codex: makeReplayAdapter(commandWithApproval) }),
			)(
				Effect.gen(function* () {
					const sessions = yield* SessionService;
					yield* sessions.setApiKey("claude", Redacted.make(apiKey));
					const session = yield* addSession(tempDir, "claude");
					yield* sessions.sendMessage(session.id, "run the tests", [], false);
					yield* waitForStatus(session.id, "awaitingApproval");
					yield* sessions.respondToApproval(session.id, "0", "allowOnce");
					yield* waitForStatus(session.id, "idle");
					yield* Effect.logInfo("Session input", claude.inputs[0]);
					const fs = yield* FileSystem.FileSystem;
					const files = yield* Effect.forEach(["", "-wal"], (suffix) =>
						fs
							.readFileString(join(tempDir, "data", `${DATABASE_FILE_NAME}${suffix}`))
							.pipe(Effect.orElseSucceed(() => "")),
					);
					return { database: files.join(""), authMode: (yield* sessions.list(session.workspaceId))[0]?.authMode };
				}),
			).pipe(Effect.provide(Logger.layer([capture]))),
		);
		const auth = claude.inputs[0]?.auth;
		expect(auth?.mode === "apiKey" && Redacted.value(auth.apiKey)).toBe(apiKey);
		expect(result.authMode).toBe("apiKey");
		expect(logs.length).toBeGreaterThan(0);
		expect(logs.join("\n")).not.toContain(apiKey);
		expect(result.database.length).toBeGreaterThan(0);
		expect(result.database).not.toContain(apiKey);
	});
});
