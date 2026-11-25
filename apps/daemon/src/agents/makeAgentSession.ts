import {
	type AgentCapabilities,
	type AgentCommand,
	ApprovalNotFoundError,
	QuestionNotFoundError,
	PlanNotFoundError,
	SessionBusyError,
} from "@repo/contracts/AgentSession";
import {
	type AgentError,
	AgentProcessError,
	type AgentSessionHandle,
	ApprovalChoiceError,
	type SessionSettings,
	type UserMessage,
} from "./AgentAdapter.ts";
import type {
	AgentEvent,
	ApprovalDecision,
	ApprovalOutcome,
	QuestionOutcome,
	QuestionAnswers,
	PlanAnswer,
	PlanOutcome,
} from "@repo/contracts/AgentEvent";
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
import { makeUniqueId } from "./makeUniqueId.ts";

// Events wait here until the consumer reads them. A full buffer slows the agent reader
// down instead of growing memory.
const EVENT_BUFFER = 256;
export const MAX_QUEUED_MESSAGES = 8;

// Shown for queued messages the agent never got, so none of them goes missing without a word.
export const unsentNotice = (messages: ReadonlyArray<UserMessage>): AgentEvent => ({
	type: "error",
	message: `The agent stopped, so Octopus did not send ${messages.length === 1 ? "this queued message" : "these queued messages"}: ${messages
		.map(({ text, images }) => `"${text || `${images.length} ${images.length === 1 ? "image" : "images"}`}"`)
		.join(", ")}`,
	willRetry: false,
});

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

type PlanRequest = Omit<Extract<AgentEvent, { type: "plan.proposed" }>, "type">;

// Returns the message to send next, if the agent waits for one after its plan.
type RespondToPlan = (outcome: PlanOutcome) => Effect.Effect<Option.Option<string>, AgentError>;

type QuestionRequest = Omit<Extract<AgentEvent, { type: "question.asked" }>, "type">;

type RespondToQuestions = (outcome: QuestionOutcome) => Effect.Effect<void, AgentError>;

// What each adapter does to drive its agent. The session below owns everything else:
// the event buffer, turn queue, pending approvals and the native id.
export interface TurnDriver {
	startTurn(message: UserMessage): Effect.Effect<void, AgentError>;
	// False when the agent has no turn it can take the message into right now, so it waits for its own turn.
	steerTurn(message: UserMessage): Effect.Effect<boolean, AgentError>;
	readonly interruptTurn: Effect.Effect<void, AgentError>;
	updateSettings(settings: SessionSettings): Effect.Effect<void, AgentError>;
	readonly listCommands: Effect.Effect<ReadonlyArray<AgentCommand>, AgentError>;
}

export interface AgentSession {
	emit(event: AgentEvent): Effect.Effect<void>;
	// Agent output Octopus does not show, like a subagent's messages or a command's streamed output, still
	// proves the turn is alive, so it keeps the watchdog from stopping it.
	readonly touch: Effect.Effect<void>;
	requestApproval(request: ApprovalRequest, respond: RespondToAgent): Effect.Effect<void>;
	proposePlan(request: PlanRequest, respond: RespondToPlan): Effect.Effect<void>;
	// For an agent that withdraws its own plan. Does nothing once the plan is answered.
	cancelPlan(requestId: string): Effect.Effect<void, AgentError>;
	askQuestions(request: QuestionRequest, respond: RespondToQuestions): Effect.Effect<void>;
	// For an agent that withdraws its own questions. Does nothing once they are answered.
	cancelQuestions(requestId: string): Effect.Effect<void, AgentError>;
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
	yield* Effect.addFinalizer(() => endWith(Queue.end(events)));
	const nativeId = yield* Deferred.make<string, AgentError>();
	const inbox = yield* Queue.bounded<{
		readonly message: UserMessage;
		readonly beforeTurn: Effect.Effect<void>;
		readonly discard: Effect.Effect<void>;
	}>(MAX_QUEUED_MESSAGES);
	// Sending, starting, dropping a queued message and ending the session each happen as one step under it, so a
	// message is either stored and started, or dropped and handed back, never both or neither.
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

	const plans = new Map<
		string,
		{
			readonly choices: PlanRequest["choices"];
			readonly respond: RespondToPlan;
		}
	>();
	const questions = new Map<
		string,
		{
			readonly questions: QuestionRequest["questions"];
			readonly respond: RespondToQuestions;
		}
	>();
	// An approval, plan or question waiting on the user, so a quiet turn is not a stalled one.
	const waitingOnUser = () => approvals.size > 0 || plans.size > 0 || questions.size > 0;

	const touch = Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(lastEventAt, now));

	const emit = (agentEvent: AgentEvent) =>
		Effect.gen(function* () {
			yield* touch;
			let event = agentEvent;
			if (event.type === "turn.completed") {
				const stall = yield* Ref.getAndSet(stalled, Option.none());
				if (Option.isSome(stall)) event = { ...event, result: { status: "failed", message: stall.value } };
			}
			// False once the session has ended.
			const offered = yield* Queue.offer(events, event);
			if (event.type === "turn.completed") {
				const turn = yield* Ref.get(currentTurn);
				if (Option.isSome(turn)) yield* Deferred.succeed(turn.value, undefined);
			}
			return offered;
		});

	const recordMessage = (message: UserMessage) =>
		emit({
			type: "user.message",
			itemId: message.id,
			text: message.text,
			attachments: message.images.map(({ id, mediaType }) => ({ id, mediaType })),
		});

	// Messages still waiting for their turn never reached the agent, so they leave nothing in history.
	// Callers hold the send lock.
	const dropQueued = Effect.gen(function* () {
		const dropped = yield* Queue.clear(inbox);
		yield* Effect.forEach(dropped, ({ discard }) => discard, { discard: true });
		return dropped.map(({ message }) => message);
	});

	// Queued messages can never run once the session ends, so the chat says which ones were not sent.
	const endWith = (close: Effect.Effect<unknown>) =>
		Effect.gen(function* () {
			const dropped = yield* dropQueued;
			if (dropped.length > 0) yield* emit(unsentNotice(dropped));
			yield* close;
		}).pipe(Semaphore.withPermit(sendLock), Effect.uninterruptible);

	const fail = (error: AgentError) =>
		endWith(
			Effect.gen(function* () {
				yield* Deferred.fail(nativeId, error);
				yield* Queue.fail(events, error);
			}),
		);

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

	const cancelPlan = (requestId: string) =>
		Effect.gen(function* () {
			const plan = plans.get(requestId);
			if (plan === undefined) return;
			plans.delete(requestId);
			yield* emit({ type: "plan.resolved", requestId, outcome: { type: "cancelled" } });
			yield* plan.respond({ type: "cancelled" });
		});

	const cancelQuestions = (requestId: string) =>
		Effect.gen(function* () {
			const pending = questions.get(requestId);
			if (pending === undefined) return;
			questions.delete(requestId);
			yield* emit({ type: "question.resolved", requestId, outcome: { type: "cancelled" } });
			yield* pending.respond({ type: "cancelled" });
		});

	// A plan and questions both end when the user moves on, so they are cancelled together.
	const cancelPlansAndQuestions = Effect.suspend(() =>
		Effect.forEach([...plans.keys()], cancelPlan, { discard: true }).pipe(
			Effect.andThen(Effect.forEach([...questions.keys()], cancelQuestions, { discard: true })),
		),
	);

	// A turn the agent never named gets a fresh id, so the chat shows each failure as its own notice.
	const syntheticTurnId = Effect.map(makeUniqueId, (id) => `octopus-${id}`);

	const failTurn = (error: AgentError) =>
		Effect.flatMap(syntheticTurnId, (turnId) =>
			emit({ type: "turn.completed", turnId, result: { status: "failed", message: error.message } }),
		);

	// Returns once the running turn has sent nothing for the idle timeout, outside approvals, then stops it.
	const watchTurn = (driver: TurnDriver, done: Deferred.Deferred<void>) =>
		Effect.gen(function* () {
			const { idleTimeout, interruptGrace } = yield* TurnWatchdogSettings;
			const limit = Duration.toMillis(idleTimeout);
			while (true) {
				const idleFor = (yield* Clock.currentTimeMillis) - (yield* Ref.get(lastEventAt));
				if (!waitingOnUser() && idleFor >= limit) break;
				yield* Effect.sleep(waitingOnUser() ? idleTimeout : Duration.millis(limit - idleFor));
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
				yield* Effect.logWarning("The agent did not end a stopped turn, so the session ended it and stops the agent");
				const turnId = yield* syntheticTurnId;
				// The agent may still end that turn later, which could not be told apart from the next turn's end, and
				// it may keep running it where no interrupt reaches. Ending the session stops the agent, and the next
				// message starts it again. Completing the turn ends this race, so both happen as one step.
				yield* endWith(
					emit({ type: "turn.completed", turnId, result: { status: "failed", message } }).pipe(
						Effect.andThen(Queue.end(events)),
					),
				);
			}
		});

	const start = (driver: TurnDriver) =>
		Effect.gen(function* () {
			yield* Effect.gen(function* () {
				const next = yield* Queue.peek(inbox);
				yield* next.beforeTurn;
				// Still queued until now, so a stop during beforeTurn drops it rather than starting it. Stored only
				// now, so history holds just the messages the agent got.
				const started = yield* Effect.gen(function* () {
					if (Queue.sizeUnsafe(inbox) === 0 || (yield* Queue.peek(inbox)) !== next) return false;
					yield* Queue.take(inbox);
					return yield* recordMessage(next.message);
				}).pipe(Semaphore.withPermit(sendLock));
				if (!started) return;
				const { message } = next;
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
						// A session that ended, as when its process exits while the message is on its way, can never run it.
						const stopped = new AgentProcessError({
							message: "The agent stopped before it took the message. Send it again.",
							cause: null,
						});
						if (events.state._tag !== "Open") return yield* stopped;
						const running = Option.isSome(yield* Ref.get(currentTurn));
						const steer = options?.steer && capabilities.steerWhileRunning && running;
						const busy = new SessionBusyError({ queued: MAX_QUEUED_MESSAGES });
						// Refused before it replaces anything, so a message that cannot run leaves the plan or question waiting.
						if (!steer && Queue.sizeUnsafe(inbox) >= MAX_QUEUED_MESSAGES) return yield* busy;
						// A new message replaces an unanswered plan or question, as typing past the prompt does in both CLIs.
						yield* cancelPlansAndQuestions;
						// Recorded only once the agent took it, so a rejected steer leaves no message in history
						// that the agent never saw, and the caller can safely drop its images.
						const beforeTurn = options?.beforeTurn ?? Effect.void;
						// A steer that falls back to queueing runs it again before its own turn.
						if (steer && (yield* beforeTurn.pipe(Effect.andThen(driver.steerTurn(message))))) {
							if (!(yield* recordMessage(message))) return yield* stopped;
							return "steered" as const;
						}
						if (Queue.sizeUnsafe(inbox) >= MAX_QUEUED_MESSAGES) return yield* busy;
						Queue.offerUnsafe(inbox, { message, beforeTurn, discard: options?.discard ?? Effect.void });
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
				respondToPlan: (requestId, answer: PlanAnswer) =>
					Effect.gen(function* () {
						const plan = plans.get(requestId);
						if (plan === undefined) {
							return yield* new PlanNotFoundError({ requestId });
						}
						if (answer.type === "approve" && !plan.choices.includes(answer.mode)) {
							return yield* new ApprovalChoiceError({ requestId, decision: answer.mode });
						}
						plans.delete(requestId);
						yield* emit({ type: "plan.resolved", requestId, outcome: answer });
						return yield* plan.respond(answer);
					}),
				answerQuestion: (requestId, answers: QuestionAnswers) =>
					Effect.gen(function* () {
						const pending = questions.get(requestId);
						if (pending === undefined) {
							return yield* new QuestionNotFoundError({ requestId });
						}
						questions.delete(requestId);
						const stored = Object.fromEntries(
							Object.entries(answers).filter(([id]) => !pending.questions.some((q) => q.id === id && q.secret)),
						);
						yield* emit({ type: "question.resolved", requestId, outcome: { type: "answered", answers: stored } });
						yield* pending.respond({ type: "answered", answers });
					}),
				// Messages waiting for their turn would start the moment the stopped turn ends, so a stop drops them
				// first and hands them back.
				dropQueued: Semaphore.withPermit(sendLock, dropQueued),
				interrupt: Effect.gen(function* () {
					yield* cancelApprovals;
					yield* cancelPlansAndQuestions;
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
		touch,
		requestApproval: (request, respond) =>
			Effect.gen(function* () {
				approvals.set(request.requestId, { choices: request.choices, respond });
				yield* emit({ type: "approval.requested", ...request });
			}),
		cancelApproval,
		proposePlan: (request, respond) =>
			Effect.gen(function* () {
				plans.set(request.requestId, { choices: request.choices, respond });
				yield* emit({ type: "plan.proposed", ...request });
			}),
		cancelPlan,
		askQuestions: (request, respond) =>
			Effect.gen(function* () {
				questions.set(request.requestId, { questions: request.questions, respond });
				yield* emit({ type: "question.asked", ...request });
			}),
		cancelQuestions,
		nativeSessionId: Deferred.await(nativeId),
		setNativeSessionId: (id) =>
			Effect.gen(function* () {
				if (yield* Deferred.succeed(nativeId, id)) {
					yield* emit({ type: "session.started", nativeSessionId: id });
				}
			}),
		fail,
		end: endWith(Queue.end(events)),
		start,
	} satisfies AgentSession;
});
