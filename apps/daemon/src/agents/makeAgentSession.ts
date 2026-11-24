import {
	type AgentError,
	type AgentSessionHandle,
	ApprovalChoiceError,
	type SessionSettings,
	type UserMessage,
} from "./AgentAdapter.ts";
import {
	type Cause,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Option,
	Queue,
	Ref,
	type Scope,
	Semaphore,
	Stream,
} from "effect";
import {
	type AgentCapabilities,
	type AgentCommand,
	ApprovalNotFoundError,
	SessionBusyError,
} from "@repo/contracts/AgentSession";
import type { AgentEvent, ApprovalDecision, ApprovalOutcome } from "@repo/contracts/AgentEvent";

// Events wait here until the consumer reads them. A full buffer slows the agent reader
// down instead of growing memory.
const EVENT_BUFFER = 256;
export const MAX_QUEUED_MESSAGES = 8;

export const TurnWatchdogSettings = Context.Reference<{
	// A turn that sends no event for this long is stopped and fails, so a hung agent cannot hold the
	// session forever. Time spent waiting on the user's approval does not count.
	readonly idleTimeout: Duration.Duration;
	// How long the stopped turn may take to end before the session ends it without the agent.
	readonly interruptGrace: Duration.Duration;
}>("octopus/daemon/agents/TurnWatchdogSettings", {
	defaultValue: () => ({ idleTimeout: Duration.minutes(10), interruptGrace: Duration.seconds(30) }),
});

type ApprovalRequest = Omit<Extract<AgentEvent, { type: "approval.requested" }>, "type">;

type RespondToAgent = (outcome: ApprovalOutcome) => Effect.Effect<void, AgentError>;

// What each adapter does to drive its agent. The session below owns everything else:
// the event buffer, turn queue, pending approvals and the native id.
export interface TurnDriver {
	startTurn(message: UserMessage): Effect.Effect<void, AgentError>;
	steerTurn(message: UserMessage): Effect.Effect<void, AgentError>;
	readonly interruptTurn: Effect.Effect<void, AgentError>;
	updateSettings(settings: SessionSettings): Effect.Effect<void, AgentError>;
	readonly listCommands: Effect.Effect<ReadonlyArray<AgentCommand>, AgentError>;
}

export interface AgentSession {
	emit(event: AgentEvent): Effect.Effect<void>;
	requestApproval(request: ApprovalRequest, respond: RespondToAgent): Effect.Effect<void>;
	// For an agent that withdraws its own request. Does nothing once the request is answered.
	cancelApproval(requestId: string): Effect.Effect<void, AgentError>;
	setNativeSessionId(id: string): Effect.Effect<void>;
	readonly nativeSessionId: Effect.Effect<string, AgentError>;
	fail(error: AgentError): Effect.Effect<void>;
	readonly end: Effect.Effect<void>;
	start(driver: TurnDriver): Effect.Effect<AgentSessionHandle, never, Scope.Scope>;
}

export const makeAgentSession = Effect.fnUntraced(function* (capabilities: AgentCapabilities) {
	const events = yield* Queue.bounded<AgentEvent, AgentError | Cause.Done>(EVENT_BUFFER);
	yield* Effect.addFinalizer(() => Queue.end(events));
	const nativeId = yield* Deferred.make<string, AgentError>();
	const inbox = yield* Queue.bounded<UserMessage>(MAX_QUEUED_MESSAGES);
	// Checking room, storing the message and queueing it happen as one step, so history order matches.
	const sendLock = yield* Semaphore.make(1);
	const currentTurn = yield* Ref.make(Option.none<Deferred.Deferred<void>>());
	const lastEventAt = yield* Ref.make(0);
	// Set while the watchdog stops a turn, so the agent's own end of that turn reports this failure.
	const stalled = yield* Ref.make(Option.none<string>());
	const approvals = new Map<
		string,
		{
			readonly choices: ReadonlyArray<ApprovalDecision>;
			readonly respond: RespondToAgent;
		}
	>();

	const emit = (agentEvent: AgentEvent) =>
		Effect.gen(function* () {
			yield* Ref.set(lastEventAt, yield* Clock.currentTimeMillis);
			let event = agentEvent;
			if (event.type === "turn.completed") {
				const stall = yield* Ref.getAndSet(stalled, Option.none());
				if (Option.isSome(stall)) event = { ...event, result: { status: "failed", message: stall.value } };
			}
			yield* Queue.offer(events, event);
			if (event.type === "turn.completed") {
				const turn = yield* Ref.get(currentTurn);
				if (Option.isSome(turn)) yield* Deferred.succeed(turn.value, undefined);
			}
		});

	const fail = (error: AgentError) =>
		Effect.gen(function* () {
			yield* Deferred.fail(nativeId, error);
			yield* Queue.fail(events, error);
		});

	const resolve = (requestId: string, outcome: ApprovalOutcome) =>
		emit({ type: "approval.resolved", requestId, outcome });

	const cancelApproval = (requestId: string) =>
		Effect.gen(function* () {
			const approval = approvals.get(requestId);
			if (approval === undefined) return;
			approvals.delete(requestId);
			yield* resolve(requestId, "cancelled");
			yield* approval.respond("cancelled");
		});

	const cancelApprovals = Effect.suspend(() =>
		Effect.forEach([...approvals.keys()], cancelApproval, { discard: true }),
	);

	const failTurn = (error: AgentError) =>
		emit({ type: "turn.completed", turnId: "notStarted", result: { status: "failed", message: error.message } });

	// Returns once the running turn has sent nothing for the idle timeout, outside approvals, then stops it.
	const watchTurn = (driver: TurnDriver, done: Deferred.Deferred<void>) =>
		Effect.gen(function* () {
			const { idleTimeout, interruptGrace } = yield* TurnWatchdogSettings;
			const limit = Duration.toMillis(idleTimeout);
			while (true) {
				const idleFor = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastEventAt));
				if (approvals.size === 0 && idleFor >= limit) break;
				yield* Effect.sleep(approvals.size === 0 ? Duration.millis(limit - idleFor) : idleTimeout);
			}
			const message = `The agent sent nothing for ${Duration.format(idleTimeout)}, so Octopus stopped the turn. Send your message again to retry.`;
			yield* Effect.logWarning("Stopping a turn that sent nothing").pipe(
				Effect.annotateLogs({ idleTimeout: Duration.format(idleTimeout) }),
			);
			yield* Ref.set(stalled, Option.some(message));
			yield* driver.interruptTurn.pipe(
				Effect.catch((error) => Effect.logWarning("Could not interrupt a stalled turn", error)),
			);
			const ended = yield* Deferred.await(done).pipe(Effect.timeoutOption(interruptGrace));
			if (Option.isNone(ended)) {
				yield* Effect.logWarning("The agent did not end a stopped turn, so the session ended it");
				yield* emit({ type: "turn.completed", turnId: "notCompleted", result: { status: "failed", message } });
			}
		});

	const start = (driver: TurnDriver) =>
		Effect.gen(function* () {
			yield* Effect.gen(function* () {
				const message = yield* Queue.take(inbox);
				const done = yield* Deferred.make<void>();
				yield* Ref.set(currentTurn, Option.some(done));
				yield* Ref.set(lastEventAt, yield* Clock.currentTimeMillis);
				// A rejected or unanswered turn fails only that turn. A process that really died also ends the
				// adapter's event reader, which ends the session.
				yield* driver
					.startTurn(message)
					.pipe(Effect.catchTags({ AgentProtocolError: failTurn, AgentProcessError: failTurn }));
				yield* Deferred.await(done).pipe(Effect.raceFirst(watchTurn(driver, done)));
				yield* Ref.set(currentTurn, Option.none());
			}).pipe(Effect.forever, Effect.catch(fail), Effect.forkScoped);

			return {
				nativeSessionId: Deferred.await(nativeId),
				events: Stream.fromQueue(events),
				sendMessage: (message, options) =>
					Effect.gen(function* () {
						const running = Option.isSome(yield* Ref.get(currentTurn));
						const steer = options?.steer && capabilities.steerWhileRunning && running;
						if (!steer && Queue.sizeUnsafe(inbox) >= MAX_QUEUED_MESSAGES) {
							return yield* new SessionBusyError({ queued: MAX_QUEUED_MESSAGES });
						}
						const recordMessage = emit({
							type: "user.message",
							itemId: message.id,
							text: message.text,
							attachments: message.images.map(({ id, mediaType }) => ({ id, mediaType })),
						});
						if (steer) {
							// Recorded only once the agent took it, so a rejected steer leaves no message in history
							// that the agent never saw, and the caller can safely drop its images.
							yield* driver.steerTurn(message);
							yield* recordMessage;
							return "steered" as const;
						}
						yield* recordMessage;
						Queue.offerUnsafe(inbox, message);
						return "queued" as const;
					}).pipe(Semaphore.withPermit(sendLock)),
				respondToApproval: (requestId, decision) =>
					Effect.gen(function* () {
						const approval = approvals.get(requestId);
						if (approval === undefined) {
							return yield* new ApprovalNotFoundError({ requestId });
						}
						if (!approval.choices.includes(decision)) {
							return yield* new ApprovalChoiceError({ requestId, decision });
						}
						approvals.delete(requestId);
						// Resolve before answering, so the agent's next events follow it.
						yield* resolve(requestId, decision);
						yield* approval.respond(decision);
					}),
				interrupt: Effect.gen(function* () {
					yield* cancelApprovals;
					if (Option.isSome(yield* Ref.get(currentTurn))) {
						yield* driver.interruptTurn;
					}
				}),
				updateSettings: driver.updateSettings,
				listCommands: driver.listCommands,
			} satisfies AgentSessionHandle;
		});

	return {
		emit,
		requestApproval: (request, respond) =>
			Effect.gen(function* () {
				approvals.set(request.requestId, { choices: request.choices, respond });
				yield* emit({ type: "approval.requested", ...request });
			}),
		cancelApproval,
		nativeSessionId: Deferred.await(nativeId),
		setNativeSessionId: (id) =>
			Effect.gen(function* () {
				if (yield* Deferred.succeed(nativeId, id)) {
					yield* emit({ type: "session.started", nativeSessionId: id });
				}
			}),
		fail,
		end: Effect.asVoid(Queue.end(events)),
		start,
	} satisfies AgentSession;
});
