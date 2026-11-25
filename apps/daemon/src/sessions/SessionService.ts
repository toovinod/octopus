import {
	AgentAuthMode,
	type AgentAvailability,
	AgentInfo,
	type AgentKind,
	type AgentLoginResult,
	type AgentMode,
	AgentSession,
	type AgentSessionStatus,
	AgentUnavailableError,
	ApprovalNotFoundError,
	AttachmentNotFoundError,
	AuthModeNotAllowedError,
	LoginNotPendingError,
	ModeNotAllowedError,
	PlanNotFoundError,
	QuestionNotFoundError,
	type ImageData,
	ImageMediaType,
	ImagesNotSupportedError,
	ResubscribeRequiredError,
	SessionNotFoundError,
} from "@repo/contracts/AgentSession";
import {
	type AgentAdapter,
	type AgentAuthStatus,
	type AgentError,
	type AgentModels,
	AgentProcessError,
	type AgentSessionHandle,
	type SessionSettings,
	type StartSessionInput,
	type UserImage,
} from "../agents/AgentAdapter.ts";
import {
	type Cause,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	PubSub,
	Queue,
	RcMap,
	type Redacted,
	Result,
	Schedule,
	Schema,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import {
	beforeRevertRef,
	changesSince,
	checkpointRef,
	findCheckpoint,
	restoreCheckpoint,
	saveCheckpoint,
} from "../checkpoints/workspaceCheckpoints.ts";
import {
	AgentEvent,
	type ApprovalDecision,
	type QuestionAnswers,
	isLiveOnly,
	type PlanAnswer,
} from "@repo/contracts/AgentEvent";
import { LocalDatabase, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../database/LocalDatabase.ts";
import { agentSession, project, sessionEvent, setting, workspace } from "../database/schema.ts";
import { CheckpointNotFoundError, WorkspaceAgentsBusyError } from "@repo/contracts/Checkpoint";
import { WorkspaceArchivedError, WorkspaceNotFoundError } from "@repo/contracts/Workspace";
import { and, asc, desc, eq, gt, inArray, lt, max } from "drizzle-orm";
import { ClaudeAdapter } from "../agents/claude/ClaudeAdapter.ts";
import { CodexAdapter } from "../agents/codex/CodexAdapter.ts";
import { CredentialStore } from "../agents/CredentialStore.ts";
import { ProjectService } from "../projects/ProjectService.ts";
import { WorkspaceLock } from "../workspaces/WorkspaceLock.ts";
import { AgentProbeSettings } from "./AgentProbeSettings.ts";
import { SessionEvent } from "@repo/contracts/SessionEvent";
import type { ChildProcessSpawner } from "effect/process";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import type { SecureRandom } from "effect/crypto";
import { nowIso } from "../database/nowIso.ts";
import { newId } from "../database/newId.ts";
import { runGit } from "../git/runGit.ts";
import { Base64 } from "effect/encoding";
import { join } from "node:path";

const HISTORY_PAGE_SIZE = 200;
const SUBSCRIBER_MAX_EVENTS = 1_000;
const SUBSCRIBER_MAX_BYTES = 1_000_000;
const STOP_GRACE = "5 seconds";
const IDLE_TIMEOUT = Duration.toNanosUnsafe("5 minutes");
const IDLE_SWEEP_INTERVAL = "30 seconds";

type SessionRow = typeof agentSession.$inferSelect;
type RestingStatus = Extract<AgentSessionStatus, "idle" | "interrupted" | "failed">;

// The live agent process of one session and what the daemon tracks about its turns.
interface Runtime {
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly agent: AgentKind;
	readonly handle: AgentSessionHandle;
	// Owns the agent process. Closing it ends the process.
	readonly scope: Scope.Closeable;
	// Completes once every event of the process is stored.
	readonly done: Deferred.Deferred<void>;
	ending: boolean;
	idleSince: bigint;
	nextSequence: number;
	// Turns sent and not yet completed, including queued ones.
	outstanding: number;
	// Each approval, plan or question waiting on the user, with what to store if nothing ever answers it.
	readonly approvals: Map<string, Cancellation>;
	// The status when no turn or approval is pending.
	resting: RestingStatus;
	status: AgentSessionStatus;
}

interface Published {
	readonly event: SessionEvent;
	readonly bytes: number;
}

type Cancellation = Extract<AgentEvent, { type: "approval.resolved" | "plan.resolved" | "question.resolved" }>;

// How a request is closed when the process that asked it ends, so the chat stops offering to answer it.
const cancellationOf = (event: AgentEvent): Cancellation | undefined => {
	switch (event.type) {
		case "approval.requested":
			return { type: "approval.resolved", requestId: event.requestId, outcome: "cancelled" };
		case "plan.proposed":
			return { type: "plan.resolved", requestId: event.requestId, outcome: { type: "cancelled" } };
		case "question.asked":
			return { type: "question.resolved", requestId: event.requestId, outcome: { type: "cancelled" } };
		default:
			return undefined;
	}
};

const requestEventTypes = [
	"approval.requested",
	"approval.resolved",
	"plan.proposed",
	"plan.resolved",
	"question.asked",
	"question.resolved",
] as const;

const isBusy = (status: AgentSessionStatus) => status === "running" || status === "awaitingApproval";

const statusOf = (runtime: Runtime): AgentSessionStatus =>
	runtime.approvals.size > 0 ? "awaitingApproval" : runtime.outstanding > 0 ? "running" : runtime.resting;

const authModeSetting = (agent: AgentKind) => `agentAuthMode.${agent}`;
const decodeAuthMode = Schema.decodeUnknownOption(AgentAuthMode);

const toAvailability = (error: AgentError): AgentAvailability => {
	switch (error._tag) {
		case "AgentNotInstalledError":
			return { status: "notInstalled" };
		case "CodexVersionMismatchError":
			return { status: "versionMismatch", expected: error.expected, actual: error.actual };
		case "AgentProcessError":
		case "AgentProtocolError":
			return { status: "unknown", message: error.message };
		// The provider refused the stored key or sign-in, which the user fixes like a missing one.
		case "AgentAuthError":
			return { status: "loggedOut" };
	}
};

const fromAuthStatus = (auth: AgentAuthStatus): AgentAvailability => {
	switch (auth.status) {
		case "loggedIn":
			return { status: "ready", account: auth.account };
		case "loggedOut":
			return { status: "loggedOut" };
		case "unknown":
			return { status: "unknown", message: "Octopus could not read its sign-in status." };
	}
};

const toUnavailable = (agent: AgentKind) => (error: AgentError) =>
	new AgentUnavailableError({ agent, availability: toAvailability(error) });

const decodeEvent = Schema.decodeUnknownEffect(AgentEvent);
const decodeEventOption = Schema.decodeUnknownOption(AgentEvent);
const decodeMediaType = Schema.decodeUnknownOption(ImageMediaType);

export class SessionService extends Context.Service<SessionService>()("octopus/daemon/sessions/SessionService", {
	make: Effect.gen(function* () {
		const database = yield* LocalDatabase;
		const credentials = yield* CredentialStore;
		const workspaceLock = yield* WorkspaceLock;
		const projects = yield* ProjectService;
		const claude = yield* ClaudeAdapter;
		const codex = yield* CodexAdapter;
		const adapters: Record<AgentKind, AgentAdapter> = { claude, codex };
		const services = yield* Effect.context<
			SecureRandom.SecureRandom | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
		>();
		const fs = yield* FileSystem.FileSystem;
		const { dataDir } = yield* DaemonConfig;
		const attachmentsDir = (sessionId: string) => join(dataDir, "attachments", sessionId);
		const clock = yield* Clock.Clock;
		const events = yield* PubSub.unbounded<Published>();
		const sessionChanges = yield* PubSub.unbounded<AgentSession>();
		const runtimes = new Map<string, Runtime>();
		const processLocks = yield* RcMap.make({ lookup: (_sessionId: string) => Semaphore.make(1) });
		// A send and a stop must agree on which process owns the session, even as other sessions start or stop.
		const withProcessLock = <A, E, R>(sessionId: string, effect: Effect.Effect<A, E, R>) =>
			RcMap.get(processLocks, sessionId).pipe(
				Effect.flatMap((lock) => lock.withPermit(effect)),
				Effect.scoped,
			);
		// Event consumers live here. Its finalizer runs after the shutdown finalizer below,
		// so consumers can still store the last events of the processes being stopped.
		const consumers = yield* Scope.fork(yield* Effect.scope);
		// Model lists come from the agents and rarely change, so each is fetched once per sign-in.
		// The account decides which models an agent offers, so a new key or auth mode fetches it again.
		const modelCache = new Map<AgentKind, AgentModels>();
		const forgetModels = (agent: AgentKind) => void modelCache.delete(agent);
		// A finished sign-in changes the account, and with it the models the agent offers. Clients hear about it
		// here instead of asking again.
		// Only recent results matter, so a client that stops reading cannot make the backlog grow.
		const agentLogins = yield* PubSub.sliding<AgentLoginResult>(16);
		const loginsOf = (agent: AgentKind, results: Stream.Stream<{ readonly success: boolean }>) =>
			Stream.map(results, ({ success }): AgentLoginResult => ({ agent, success }));
		yield* Stream.merge(loginsOf("claude", claude.loginResults), loginsOf("codex", codex.loginResults)).pipe(
			Stream.runForEach((result) =>
				Effect.gen(function* () {
					if (result.success) forgetModels(result.agent);
					yield* PubSub.publish(agentLogins, result);
				}),
			),
			Effect.forkScoped,
		);

		// Sessions made before modes existed have none stored and keep the agent's default.
		const defaultMode = (agent: AgentKind) => adapters[agent].capabilities.modes[0] ?? "ask";
		const toSession = (row: SessionRow) => new AgentSession({ ...row, mode: row.mode ?? defaultMode(row.agent) });

		const getRow = Effect.fn("SessionService.getRow")(function* (sessionId: string) {
			const [row] = yield* database.query((db) => db.select().from(agentSession).where(eq(agentSession.id, sessionId)));
			if (row === undefined) {
				return yield* new SessionNotFoundError({ sessionId });
			}
			return row;
		});

		const updateSession = Effect.fnUntraced(function* (
			sessionId: string,
			patch: Partial<
				Pick<SessionRow, "status" | "nativeSessionId" | "authMode" | "title" | "model" | "effort" | "mode">
			>,
		) {
			const updatedAt = yield* nowIso;
			const [row] = yield* database.query((db) =>
				db
					.update(agentSession)
					.set({ ...patch, updatedAt })
					.where(eq(agentSession.id, sessionId))
					.returning(),
			);
			if (row === undefined) return undefined;
			const session = toSession(row);
			yield* PubSub.publish(sessionChanges, session);
			return session;
		});

		const refreshStatus = (runtime: Runtime) => {
			const status = statusOf(runtime);
			if (status === runtime.status) return Effect.void;
			if (!isBusy(status)) runtime.idleSince = clock.currentTimeNanosUnsafe();
			// Set before the write so concurrent callers write in the order they decided.
			runtime.status = status;
			return Effect.asVoid(updateSession(runtime.sessionId, { status }));
		};

		// The budget is in bytes, and a string's length counts UTF-16 units, a third of the bytes for CJK text.
		const publish = (event: SessionEvent) =>
			PubSub.publish(events, { event, bytes: Buffer.byteLength(JSON.stringify(event.event)) });

		// Stored events are written before they are published, so a subscriber never misses one.
		const record = Effect.fnUntraced(function* (runtime: Runtime, event: AgentEvent) {
			const { sessionId } = runtime;
			const createdAt = yield* nowIso;
			if (isLiveOnly(event)) {
				return yield* publish(new SessionEvent({ sessionId, sequence: null, event, createdAt }));
			}
			const sequence = runtime.nextSequence;
			const id = yield* newId;
			yield* database.query((db) =>
				db.insert(sessionEvent).values({ id, sessionId, sequence, type: event.type, payload: event, createdAt }),
			);
			runtime.nextSequence++;
			yield* publish(new SessionEvent({ sessionId, sequence, event, createdAt }));
			switch (event.type) {
				case "session.started":
					yield* updateSession(sessionId, { nativeSessionId: event.nativeSessionId });
					break;
				case "mode.changed":
					yield* updateSession(sessionId, { mode: event.mode });
					break;
				// A plan or a question waits on the user like an approval does, so the chat shows it needs them.
				case "approval.requested":
				case "plan.proposed":
				case "question.asked": {
					const cancellation = cancellationOf(event);
					if (cancellation !== undefined) runtime.approvals.set(event.requestId, cancellation);
					break;
				}
				case "approval.resolved":
				case "plan.resolved":
				case "question.resolved":
					runtime.approvals.delete(event.requestId);
					break;
				case "turn.completed":
					runtime.outstanding = Math.max(0, runtime.outstanding - 1);
					// A failed turn leaves the process usable, so the next message runs as usual. The status still
					// says it failed, so the UI reports a failure rather than a finished turn.
					runtime.resting = event.result.status === "completed" ? "idle" : event.result.status;
					break;
			}
			yield* refreshStatus(runtime);
		}, Effect.provide(services));

		const consume = Effect.fnUntraced(
			function* (runtime: Runtime) {
				const outcome = yield* runtime.handle.events.pipe(
					Stream.runForEach((event) => record(runtime, event)),
					Effect.result,
				);
				runtime.ending = true;
				yield* Scope.close(runtime.scope, Exit.void);
				// Nothing can answer what the process left open, so history closes it instead of offering it forever.
				for (const cancellation of [...runtime.approvals.values()]) yield* record(runtime, cancellation);
				if (runtime.outstanding > 0) {
					const turnId = yield* newId.pipe(Effect.provide(services));
					yield* record(runtime, { type: "turn.completed", turnId, result: { status: "interrupted" } });
				}
				runtime.approvals.clear();
				runtime.outstanding = 0;
				if (Result.isSuccess(outcome)) {
					// The process ended, either stopped by us or on its own.
					if (isBusy(runtime.status)) runtime.resting = "interrupted";
				} else if (outcome.failure._tag === "LocalDatabaseError") {
					yield* Effect.logError("Could not store a session event", outcome.failure);
					runtime.resting = "failed";
				} else {
					const error = outcome.failure;
					yield* Effect.logError("Agent session failed", error).pipe(
						Effect.annotateLogs({ sessionId: runtime.sessionId }),
					);
					const message =
						// An auth error's own message says to fix the credential, which the session cannot do itself.
						error._tag === "AgentProcessError" || error._tag === "AgentProtocolError" || error._tag === "AgentAuthError"
							? error.message
							: toUnavailable(runtime.agent)(error).message;
					yield* record(runtime, { type: "error", message, willRetry: false });
					runtime.resting = "failed";
				}
				yield* refreshStatus(runtime);
			},
			(effect, runtime) =>
				effect.pipe(
					Effect.catch((error) => Effect.logError("Could not finish an agent session", error)),
					Effect.ensuring(
						Effect.sync(() => {
							if (runtimes.get(runtime.sessionId) === runtime) runtimes.delete(runtime.sessionId);
						}).pipe(Effect.andThen(Deferred.succeed(runtime.done, undefined))),
					),
				),
		);

		// Callers hold this session's process lock.
		const stopRuntime = Effect.fnUntraced(function* (runtime: Runtime) {
			// Cancel pending approvals and record the interrupted turn before closing the process.
			const interrupt =
				!runtime.ending && isBusy(runtime.status)
					? runtime.handle.interrupt.pipe(
							Effect.timeoutOption(STOP_GRACE),
							Effect.catch((error) => Effect.logWarning("Could not interrupt the agent before stopping it", error)),
						)
					: Effect.void;
			yield* interrupt.pipe(
				Effect.ensuring(Scope.close(runtime.scope, Exit.void).pipe(Effect.andThen(Deferred.await(runtime.done)))),
			);
		});

		const stopRuntimes = (shouldStop: (runtime: Runtime) => boolean) =>
			Effect.suspend(() =>
				Effect.forEach(
					[...runtimes.values()].filter(shouldStop),
					(runtime) =>
						withProcessLock(
							runtime.sessionId,
							Effect.suspend(() =>
								runtimes.get(runtime.sessionId) === runtime && shouldStop(runtime) ? stopRuntime(runtime) : Effect.void,
							),
						),
					{ concurrency: "unbounded", discard: true },
				),
			);

		const stopExpiredRuntimes = Effect.suspend(() => {
			const cutoff = clock.currentTimeNanosUnsafe() - IDLE_TIMEOUT;
			return stopRuntimes((runtime) => !isBusy(runtime.status) && runtime.idleSince <= cutoff);
		});

		// The user's choice, else an API key when one is stored, else the agent's first mode.
		const authModeOf = Effect.fnUntraced(function* (agent: AgentKind) {
			const [stored] = yield* database.query((db) =>
				db
					.select()
					.from(setting)
					.where(eq(setting.key, authModeSetting(agent))),
			);
			const chosen = decodeAuthMode(stored?.value);
			if (Option.isSome(chosen)) return chosen.value;
			const modes = adapters[agent].authModes;
			const hasApiKey = Option.isSome(yield* credentials.get(agent));
			return hasApiKey || !modes.includes("subscription") ? "apiKey" : "subscription";
		});

		const setAuthMode = Effect.fn("SessionService.setAuthMode")(function* (agent: AgentKind, mode: AgentAuthMode) {
			if (!adapters[agent].authModes.includes(mode)) {
				return yield* new AuthModeNotAllowedError({ agent, mode });
			}
			const key = authModeSetting(agent);
			yield* database.query((db) =>
				db
					.insert(setting)
					.values({ key, value: mode })
					.onConflictDoUpdate({ target: setting.key, set: { value: mode } }),
			);
			forgetModels(agent);
		});

		const startLogin = Effect.fn("SessionService.startLogin")(function* (agent: AgentKind) {
			return { authUrl: yield* agent === "claude" ? claude.startLogin : codex.startLogin };
		});

		// Codex's sign-in returns to its own callback server, so only Claude ever waits for a pasted code.
		const submitLoginCode = Effect.fn("SessionService.submitLoginCode")(function* (agent: AgentKind, code: string) {
			if (agent === "codex") {
				return yield* new LoginNotPendingError({ agent });
			}
			yield* claude.submitLoginCode(code);
		});

		const authFor = Effect.fnUntraced(function* (agent: AgentKind) {
			if ((yield* authModeOf(agent)) === "subscription") {
				return { mode: "subscription" } satisfies StartSessionInput["auth"];
			}
			const apiKey = yield* credentials.get(agent);
			if (Option.isNone(apiKey)) {
				return yield* new AgentUnavailableError({ agent, availability: { status: "needsApiKey" } });
			}
			return { mode: "apiKey", apiKey: apiKey.value } satisfies StartSessionInput["auth"];
		});

		// A workspace's code is trusted when its project is, unless it is a fork's pull request.
		const workspaceTrust = Effect.fnUntraced(function* (workspaceId: string) {
			const [target] = yield* database.query((db) =>
				db
					.select({
						path: workspace.path,
						status: workspace.status,
						projectTrusted: project.trusted,
						fromFork: workspace.fromFork,
					})
					.from(workspace)
					.innerJoin(project, eq(workspace.projectId, project.id))
					.where(eq(workspace.id, workspaceId)),
			);
			// The foreign key keeps the workspace while a session in it exists.
			if (target === undefined) return yield* Effect.die("The session's workspace is missing");
			return { ...target, trusted: target.projectTrusted && !target.fromFork };
		});

		const startRuntime = Effect.fnUntraced(function* (row: SessionRow) {
			const target = yield* workspaceTrust(row.workspaceId);
			// An archived worktree folder is gone, and an archived in-place workspace should stay quiet.
			if (target.status === "archived") {
				return yield* new WorkspaceArchivedError({ workspaceId: row.workspaceId });
			}
			const auth = yield* authFor(row.agent);
			let mode = row.mode ?? defaultMode(row.agent);
			// The project may have lost its trust since full access was chosen.
			if (mode === "fullAccess" && !target.trusted) {
				mode = defaultMode(row.agent);
				yield* Effect.logWarning("Starting a full access session in its default mode, its code is not trusted").pipe(
					Effect.annotateLogs({ sessionId: row.id }),
				);
			}
			const scope = yield* Scope.make();
			const handle = yield* adapters[row.agent]
				.startSession({
					cwd: target.path,
					model: row.model,
					effort: row.effort,
					mode,
					trustProjectSettings: target.trusted,
					auth,
					...(row.nativeSessionId === null ? {} : { resumeId: row.nativeSessionId }),
				})
				.pipe(
					Scope.provide(scope),
					Effect.onError(() => Scope.close(scope, Exit.void)),
					Effect.mapError(toUnavailable(row.agent)),
				);
			const [stored] = yield* database.query((db) =>
				db
					.select({ last: max(sessionEvent.sequence) })
					.from(sessionEvent)
					.where(eq(sessionEvent.sessionId, row.id)),
			);
			const runtime: Runtime = {
				sessionId: row.id,
				workspaceId: row.workspaceId,
				agent: row.agent,
				handle,
				scope,
				done: yield* Deferred.make<void>(),
				ending: false,
				idleSince: clock.currentTimeNanosUnsafe(),
				nextSequence: (stored?.last ?? -1) + 1,
				outstanding: 0,
				approvals: new Map(),
				resting: isBusy(row.status) ? "idle" : row.status,
				status: row.status,
			};
			if (row.authMode !== auth.mode) {
				yield* updateSession(row.id, { authMode: auth.mode });
			}
			runtimes.set(row.id, runtime);
			yield* consume(runtime).pipe(Effect.forkIn(consumers));
			yield* Effect.logInfo("Started agent process").pipe(
				Effect.annotateLogs({ sessionId: row.id, agent: row.agent, resumed: row.nativeSessionId !== null }),
			);
			return runtime;
		});

		const ensureRuntime = Effect.fnUntraced(function* (sessionId: string) {
			const existing = runtimes.get(sessionId);
			if (existing !== undefined) {
				if (!existing.ending) return existing;
				// Its last events and status must be saved before the replacement reads them.
				yield* Deferred.await(existing.done);
			}
			return yield* startRuntime(yield* getRow(sessionId));
		});

		const checkImagesSupported = Effect.fnUntraced(function* (sessionId: string) {
			const row = yield* getRow(sessionId);
			const { models } = yield* modelsOf(row.agent).pipe(Effect.mapError(toUnavailable(row.agent)));
			const model = models.find((candidate) => candidate.id === row.model);
			// An unlisted model is left to the agent, which knows its own models best.
			if (model?.supportsImages === false) {
				return yield* new ImagesNotSupportedError({ model: model.label });
			}
		});

		// Written to disk before the agent sees them: Codex reads them from there, and history shows them later.
		const storeImages = Effect.fnUntraced(function* (sessionId: string, images: ReadonlyArray<ImageData>) {
			if (images.length === 0) return [];
			const directory = attachmentsDir(sessionId);
			yield* fs.makeDirectory(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
			return yield* Effect.forEach(images, ({ mediaType, base64 }) =>
				Effect.gen(function* () {
					const id = yield* newId;
					const path = join(directory, id);
					const bytes = yield* Effect.fromResult(Base64.decode(base64));
					yield* fs.writeFile(path, bytes, { mode: PRIVATE_FILE_MODE });
					return { id, mediaType, base64, path } satisfies UserImage;
				}),
			);
		}, Effect.provide(services));

		// Saved just before the agent sees the message, so "Revert to here" can undo everything from it on.
		// A failure only costs that checkpoint, so the message still goes.
		const saveTurnCheckpoint = Effect.fnUntraced(
			function* (sessionId: string, messageId: string) {
				const row = yield* getRow(sessionId);
				const { path } = yield* workspaceTrust(row.workspaceId);
				yield* saveCheckpoint(path, checkpointRef(row.workspaceId, sessionId, messageId));
			},
			Effect.provide(services),
			Effect.catch((cause) => Effect.logWarning("Could not save a checkpoint before the message", cause)),
		);

		const sendMessage = Effect.fn("SessionService.sendMessage")(
			function* (sessionId: string, text: string, images: ReadonlyArray<ImageData>, steer: boolean) {
				if (images.length > 0) yield* checkImagesSupported(sessionId);
				const current = yield* ensureRuntime(sessionId);
				const message = {
					id: yield* newId.pipe(Effect.provide(services)),
					text,
					images: yield* storeImages(sessionId, images),
				};
				// The process may have ended while the message was prepared. Its runtime is gone then, and the
				// message goes to a new one.
				const runtime = current.ending ? yield* ensureRuntime(sessionId) : current;
				// Counted before sending, so the turn's own completion can never arrive first.
				runtime.outstanding++;
				yield* refreshStatus(runtime);
				// Taken when the message's turn starts, so a queued message's checkpoint holds the turns before it.
				const beforeTurn = saveTurnCheckpoint(sessionId, message.id);
				const sent = yield* runtime.handle.sendMessage(message, { steer, beforeTurn }).pipe(
					Effect.mapError((error) => (error._tag === "SessionBusyError" ? error : toUnavailable(runtime.agent)(error))),
					// Also on interruption, for example when the client disconnects mid-send.
					Effect.onExit((exit) =>
						Exit.isSuccess(exit)
							? Effect.void
							: Effect.gen(function* () {
									// The process may have ended meanwhile, which already cleared the count.
									runtime.outstanding = Math.max(0, runtime.outstanding - 1);
									yield* refreshStatus(runtime);
									// The message was not stored, so nothing will ever ask for its images.
									yield* Effect.forEach(message.images, ({ path }) => Effect.ignore(fs.remove(path)));
								}),
					),
				);
				if (sent === "steered") {
					runtime.outstanding--;
					yield* refreshStatus(runtime);
				}
			},
			(effect, sessionId) => withProcessLock(sessionId, effect),
		);

		const listCommands = Effect.fn("SessionService.listCommands")(
			function* (sessionId: string) {
				const runtime = yield* ensureRuntime(sessionId);
				return yield* runtime.handle.listCommands.pipe(Effect.mapError(toUnavailable(runtime.agent)));
			},
			(effect, sessionId) => withProcessLock(sessionId, effect),
		);

		const findMessageCheckpoint = Effect.fnUntraced(function* (sessionId: string, messageId: string) {
			const row = yield* getRow(sessionId);
			const target = yield* workspaceTrust(row.workspaceId);
			if (target.status === "archived") {
				return yield* new WorkspaceArchivedError({ workspaceId: row.workspaceId });
			}
			const checkpoint = yield* findCheckpoint(target.path, checkpointRef(row.workspaceId, sessionId, messageId));
			if (checkpoint === null) return yield* new CheckpointNotFoundError({ sessionId, messageId });
			return { row, path: target.path, checkpoint };
		});

		const previewRevert = Effect.fn("SessionService.previewRevert")(function* (sessionId: string, messageId: string) {
			const { path, checkpoint } = yield* findMessageCheckpoint(sessionId, messageId);
			return (yield* changesSince(path, checkpoint)).files;
		}, Effect.provide(services));

		// Every chat in the workspace shares its folder, so none may be writing files while they change.
		const revertToMessage = Effect.fn("SessionService.revertToMessage")(function* (
			sessionId: string,
			messageId: string,
		) {
			const { row, path, checkpoint } = yield* findMessageCheckpoint(sessionId, messageId);
			const working = yield* database.query((db) =>
				db
					.select({ id: agentSession.id })
					.from(agentSession)
					.where(
						and(
							eq(agentSession.workspaceId, row.workspaceId),
							inArray(agentSession.status, ["running", "awaitingApproval"]),
						),
					)
					.limit(1),
			);
			if (working.length > 0) return yield* new WorkspaceAgentsBusyError({ workspaceId: row.workspaceId });
			const { now, files } = yield* changesSince(path, checkpoint);
			// Kept so the revert itself can be undone with git.
			yield* runGit(path, ["update-ref", beforeRevertRef(row.workspaceId, sessionId), now]);
			yield* restoreCheckpoint(path, checkpoint);
			yield* Effect.logInfo("Reverted a workspace to a checkpoint").pipe(
				Effect.annotateLogs({ sessionId, messageId, files: files.length }),
			);
			return files;
		}, Effect.provide(services));

		const respondToApproval = Effect.fn("SessionService.respondToApproval")(function* (
			sessionId: string,
			requestId: string,
			decision: ApprovalDecision,
		) {
			const runtime = runtimes.get(sessionId);
			if (runtime === undefined) {
				yield* getRow(sessionId);
				return yield* new ApprovalNotFoundError({ requestId });
			}
			yield* runtime.handle.respondToApproval(requestId, decision);
		});

		// Approving switches the chat to the chosen mode. An agent that waits for a message after its plan, as
		// Codex does, then gets the one its own CLI sends.
		const respondToPlan = Effect.fn("SessionService.respondToPlan")(function* (
			sessionId: string,
			requestId: string,
			answer: PlanAnswer,
		) {
			const row = yield* getRow(sessionId);
			const runtime = runtimes.get(sessionId);
			if (runtime === undefined) return yield* new PlanNotFoundError({ requestId });
			// Checked first, so a refused mode leaves the plan waiting for another answer.
			if (answer.type === "approve") yield* checkModeAllowed(row, answer.mode);
			const next = yield* runtime.handle.respondToPlan(requestId, answer);
			if (answer.type === "approve") {
				yield* updateSettings(sessionId, { model: row.model, effort: row.effort, mode: answer.mode });
			}
			if (Option.isSome(next)) yield* sendMessage(sessionId, next.value, [], false);
		});

		const answerQuestion = Effect.fn("SessionService.answerQuestion")(function* (
			sessionId: string,
			requestId: string,
			answers: QuestionAnswers,
		) {
			const runtime = runtimes.get(sessionId);
			if (runtime === undefined) {
				yield* getRow(sessionId);
				return yield* new QuestionNotFoundError({ requestId });
			}
			yield* runtime.handle.answerQuestion(requestId, answers);
		});

		const interrupt = Effect.fn("SessionService.interrupt")(function* (sessionId: string) {
			const runtime = runtimes.get(sessionId);
			if (runtime === undefined) {
				yield* getRow(sessionId);
				return;
			}
			yield* runtime.handle.interrupt;
		});

		const stop = Effect.fn("SessionService.stop")(
			function* (sessionId: string) {
				const runtime = runtimes.get(sessionId);
				if (runtime === undefined) {
					yield* getRow(sessionId);
					return;
				}
				yield* stopRuntime(runtime);
			},
			(effect, sessionId) => withProcessLock(sessionId, effect),
		);

		// Archiving a workspace releases every agent process in it.
		const stopWorkspace = Effect.fn("SessionService.stopWorkspace")((workspaceId: string) =>
			stopRuntimes((runtime) => runtime.workspaceId === workspaceId),
		);

		// Only once the workspace is archived: an archive that fails leaves its chats usable.
		const deleteWorkspaceAttachments = Effect.fn("SessionService.deleteWorkspaceAttachments")(function* (
			workspaceId: string,
		) {
			const sessions = yield* database.query((db) =>
				db.select({ id: agentSession.id }).from(agentSession).where(eq(agentSession.workspaceId, workspaceId)),
			);
			for (const { id } of sessions) {
				yield* fs.remove(attachmentsDir(id), { recursive: true, force: true });
			}
		});

		const getAttachment = Effect.fn("SessionService.getAttachment")(function* (
			sessionId: string,
			attachmentId: string,
		) {
			yield* getRow(sessionId);
			const rows = yield* database.query((db) =>
				db
					.select({ payload: sessionEvent.payload })
					.from(sessionEvent)
					.where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.type, "user.message"))),
			);
			const messages = yield* Effect.forEach(rows, (row) => Effect.orDie(decodeEvent(row.payload)));
			// Looking the id up in stored messages also keeps it from naming any other file.
			const attachment = messages
				.flatMap((event) => (event.type === "user.message" ? event.attachments : []))
				.find(({ id }) => id === attachmentId);
			const mediaType = decodeMediaType(attachment?.mediaType);
			if (attachment === undefined || Option.isNone(mediaType)) {
				return yield* new AttachmentNotFoundError({ attachmentId });
			}
			const bytes = yield* fs.readFile(join(attachmentsDir(sessionId), attachment.id)).pipe(
				Effect.catchIf(
					(error) => error.reason._tag === "NotFound",
					() => Effect.fail(new AttachmentNotFoundError({ attachmentId })),
				),
			);
			return { mediaType: mediaType.value, base64: Base64.encode(bytes) } satisfies ImageData;
		});

		const create = Effect.fn("SessionService.create")(function* (input: {
			readonly workspaceId: string;
			readonly agent: AgentKind;
			readonly model: string;
			readonly effort: string | null;
		}) {
			const found = yield* database.query((db) =>
				db.$count(workspace, and(eq(workspace.id, input.workspaceId), eq(workspace.status, "active"))),
			);
			if (found === 0) {
				return yield* new WorkspaceNotFoundError({ workspaceId: input.workspaceId });
			}
			const authMode = yield* authModeOf(input.agent);
			const now = yield* nowIso;
			const row: SessionRow = {
				id: yield* newId,
				...input,
				nativeSessionId: null,
				authMode,
				mode: defaultMode(input.agent),
				status: "idle",
				title: null,
				createdAt: now,
				updatedAt: now,
			};
			yield* database.query((db) => db.insert(agentSession).values(row));
			const session = toSession(row);
			yield* PubSub.publish(sessionChanges, session);
			return session;
		}, Effect.provide(services));

		const list = (workspaceId: string) =>
			database
				.query((db) =>
					db
						.select()
						.from(agentSession)
						.where(eq(agentSession.workspaceId, workspaceId))
						.orderBy(asc(agentSession.createdAt)),
				)
				.pipe(Effect.map((rows) => rows.map(toSession)));

		const rename = Effect.fn("SessionService.rename")(function* (sessionId: string, title: string) {
			const session = yield* updateSession(sessionId, { title: title.trim() || null });
			if (session === undefined) {
				return yield* new SessionNotFoundError({ sessionId });
			}
			return session;
		});

		const checkModeAllowed = Effect.fnUntraced(function* (
			row: { readonly agent: AgentKind; readonly workspaceId: string },
			mode: AgentMode,
		) {
			if (!adapters[row.agent].capabilities.modes.includes(mode)) {
				return yield* new ModeNotAllowedError({ agent: row.agent, mode, reason: "notOffered" });
			}
			if (mode === "fullAccess") {
				const target = yield* workspaceTrust(row.workspaceId);
				if (!target.trusted) {
					return yield* new ModeNotAllowedError({
						agent: row.agent,
						mode,
						reason: target.fromFork ? "fork" : "untrustedProject",
					});
				}
			}
		});

		// Under the process lock, so a process starting meanwhile cannot miss the change.
		const updateSettings = Effect.fn("SessionService.updateSettings")(
			function* (sessionId: string, settings: SessionSettings) {
				const row = yield* getRow(sessionId);
				yield* checkModeAllowed(row, settings.mode);
				// Applied before it is stored, so a change the agent refuses never shows as the session's settings.
				const runtime = runtimes.get(sessionId);
				if (runtime !== undefined) {
					yield* runtime.handle.updateSettings(settings);
				}
				const session = yield* updateSession(sessionId, settings);
				if (session === undefined) {
					return yield* new SessionNotFoundError({ sessionId });
				}
				return session;
			},
			(effect, sessionId) => withProcessLock(sessionId, effect),
		);

		const toSessionEvents = (rows: ReadonlyArray<typeof sessionEvent.$inferSelect>) =>
			Effect.forEach(rows, (row) =>
				// A row that no longer decodes means a corrupt database, not a user error.
				Effect.map(
					Effect.orDie(decodeEvent(row.payload)),
					(event) =>
						new SessionEvent({ sessionId: row.sessionId, sequence: row.sequence, event, createdAt: row.createdAt }),
				),
			);

		// Up to limit stored events before beforeSequence, oldest first. null reads the latest ones, so a chat
		// opens on its last page and subscribes after it.
		const history = Effect.fn("SessionService.history")(function* (
			sessionId: string,
			beforeSequence: number | null,
			limit: number,
		) {
			yield* getRow(sessionId);
			const rows = yield* database.query((db) =>
				db
					.select()
					.from(sessionEvent)
					.where(
						and(
							eq(sessionEvent.sessionId, sessionId),
							beforeSequence === null ? undefined : lt(sessionEvent.sequence, beforeSequence),
						),
					)
					.orderBy(desc(sessionEvent.sequence))
					.limit(limit),
			);
			return yield* toSessionEvents(rows.reverse());
		});

		const historyPage = (sessionId: string, afterSequence: number) =>
			database
				.query((db) =>
					db
						.select()
						.from(sessionEvent)
						.where(and(eq(sessionEvent.sessionId, sessionId), gt(sessionEvent.sequence, afterSequence)))
						.orderBy(asc(sessionEvent.sequence))
						.limit(HISTORY_PAGE_SIZE),
				)
				.pipe(
					Effect.flatMap((rows) =>
						toSessionEvents(rows).pipe(
							Effect.map(
								(page) =>
									[
										page,
										rows.length === HISTORY_PAGE_SIZE
											? Option.some(rows[rows.length - 1]?.sequence ?? afterSequence)
											: Option.none<number>(),
									] as const,
							),
						),
					),
				);

		// Live events are buffered from the start, then stored history is paged, then the buffer
		// drains with already-sent sequences skipped. That leaves no gap and no duplicate.
		const subscribe = (sessionId: string, afterSequence: number) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* getRow(sessionId);
					const subscription = yield* PubSub.subscribe(events);
					const buffer = yield* Queue.unbounded<Published, ResubscribeRequiredError | Cause.Done>();
					let bufferedBytes = 0;
					let lastSequence = afterSequence;

					yield* PubSub.take(subscription).pipe(
						Effect.flatMap((published) => {
							if (published.event.sessionId !== sessionId) return Effect.succeed(true);
							const full =
								Queue.sizeUnsafe(buffer) >= SUBSCRIBER_MAX_EVENTS ||
								bufferedBytes + published.bytes > SUBSCRIBER_MAX_BYTES;
							if (full) {
								// The stream below replaces lastSequence with what the client actually got.
								return Effect.as(Queue.fail(buffer, new ResubscribeRequiredError({ lastSequence })), false);
							}
							bufferedBytes += published.bytes;
							return Queue.offer(buffer, published);
						}),
						Effect.repeat({ while: (keepGoing) => keepGoing }),
						Effect.forkScoped,
					);

					const history = Stream.paginate(afterSequence, (cursor) => historyPage(sessionId, cursor));
					const live = Stream.fromQueue(buffer).pipe(
						Stream.map((published) => {
							bufferedBytes -= published.bytes;
							return published.event;
						}),
					);
					return Stream.concat(history, live).pipe(
						Stream.filter((event) => {
							if (event.sequence === null) return true;
							if (event.sequence <= lastSequence) return false;
							lastSequence = event.sequence;
							return true;
						}),
						Stream.catchTag("ResubscribeRequiredError", () =>
							Stream.fail(new ResubscribeRequiredError({ lastSequence })),
						),
					);
				}),
			);

		// Subscribed before the snapshot is read, so a change made while a client loads is never lost. A change
		// read in the snapshot can also come through the subscription, so clients keep the newest updatedAt.
		const watch = Stream.unwrap(
			Effect.gen(function* () {
				const subscription = yield* PubSub.subscribe(sessionChanges);
				// Only each session's newest change waits for a client that reads slowly, so one that stops
				// reading holds a session per chat, not every change since.
				const latest = new Map<string, AgentSession>();
				const changed = yield* Queue.sliding<void>(1);
				yield* PubSub.take(subscription).pipe(
					Effect.flatMap((session) => {
						latest.delete(session.id);
						latest.set(session.id, session);
						return Queue.offer(changed, undefined);
					}),
					Effect.forever,
					Effect.forkScoped,
				);
				const changes = Stream.fromQueue(changed).pipe(
					Stream.flatMap(() => {
						const batch = [...latest.values()];
						latest.clear();
						return Stream.fromIterable(batch);
					}),
				);
				const rows = yield* database.query((db) =>
					db
						.select({ session: agentSession })
						.from(agentSession)
						.innerJoin(workspace, eq(agentSession.workspaceId, workspace.id))
						.where(eq(workspace.status, "active"))
						.orderBy(asc(agentSession.createdAt)),
				);
				return Stream.concat(Stream.fromIterable(rows.map((row) => toSession(row.session))), changes);
			}),
		);

		const modelsOf = (kind: AgentKind) => {
			const cached = modelCache.get(kind);
			if (cached !== undefined) return Effect.succeed(cached);
			return adapters[kind].listModels.pipe(Effect.tap((models) => Effect.sync(() => modelCache.set(kind, models))));
		};

		const agentInfo = Effect.fnUntraced(function* (kind: AgentKind) {
			const adapter = adapters[kind];
			const hasApiKey = Option.isSome(yield* credentials.get(kind));
			const authMode = yield* authModeOf(kind);
			const { timeout } = yield* AgentProbeSettings;
			const withDeadline = <A, E, R>(probe: Effect.Effect<A, E, R>) =>
				probe.pipe(
					Effect.timeoutOrElse({
						duration: timeout,
						orElse: () =>
							Effect.fail(
								new AgentProcessError({ message: "The agent did not answer in time. Try again.", cause: null }),
							),
					}),
				);
			// Also run in API key mode: it is what finds a missing or mismatched CLI.
			const auth = yield* Effect.result(withDeadline(adapter.checkAuth));
			const listed = yield* Effect.result(withDeadline(modelsOf(kind)));
			if (Result.isFailure(listed)) {
				yield* Effect.logWarning("Could not list agent models, showing none", listed.failure).pipe(
					Effect.annotateLogs({ agent: kind }),
				);
			}
			const availability: AgentAvailability = Result.isFailure(auth)
				? toAvailability(auth.failure)
				: Result.isFailure(listed)
					? toAvailability(listed.failure)
					: authMode === "apiKey"
						? hasApiKey
							? { status: "ready", account: null }
							: { status: "needsApiKey" }
						: fromAuthStatus(auth.success);
			return new AgentInfo({
				kind,
				availability,
				capabilities: adapter.capabilities,
				authModes: adapter.authModes,
				authMode,
				...(Result.isSuccess(listed) ? listed.success : { models: [], defaultModel: "" }),
			});
		});

		// A keychain that cannot be read leaves that agent unknown, so the other agent and the rest of the app still work.
		const agentInfoOrUnknown = (kind: AgentKind) =>
			agentInfo(kind).pipe(
				Effect.catchTag("CredentialStoreError", (error) =>
					Effect.gen(function* () {
						yield* Effect.logWarning("Could not read the keychain", error).pipe(Effect.annotateLogs({ agent: kind }));
						const adapter = adapters[kind];
						return new AgentInfo({
							kind,
							availability: {
								status: "unknown",
								message: "Octopus could not read your keychain. Unlock it, then retry.",
							},
							capabilities: adapter.capabilities,
							authModes: adapter.authModes,
							authMode: adapter.authModes[0] ?? "apiKey",
							models: [],
							defaultModel: "",
						});
					}),
				),
			);

		const listAgents = Effect.forEach(["claude", "codex"] as const, agentInfoOrUnknown, {
			concurrency: "unbounded",
		}).pipe(Effect.withSpan("SessionService.listAgents"));

		const setApiKey = (agent: AgentKind, apiKey: Redacted.Redacted<string>) =>
			credentials.set(agent, apiKey).pipe(Effect.tap(() => Effect.sync(() => forgetModels(agent))));
		const removeApiKey = (agent: AgentKind) =>
			credentials.remove(agent).pipe(Effect.tap(() => Effect.sync(() => forgetModels(agent))));

		// The requests a restart left open are cancelled and the turn it cut off ends, as when a process ends.
		const closeCutOffHistory = Effect.fnUntraced(function* (sessionId: string) {
			const rows = yield* database.query((db) =>
				db
					.select({ payload: sessionEvent.payload })
					.from(sessionEvent)
					.where(and(eq(sessionEvent.sessionId, sessionId), inArray(sessionEvent.type, [...requestEventTypes])))
					.orderBy(asc(sessionEvent.sequence)),
			);
			const open = new Map<string, Cancellation>();
			for (const row of rows) {
				const event = decodeEventOption(row.payload);
				if (Option.isNone(event) || !("requestId" in event.value)) continue;
				const cancellation = cancellationOf(event.value);
				if (cancellation === undefined) open.delete(event.value.requestId);
				else open.set(event.value.requestId, cancellation);
			}
			const closing: Array<AgentEvent> = [
				...open.values(),
				{ type: "turn.completed", turnId: yield* newId, result: { status: "interrupted" } },
			];
			const [stored] = yield* database.query((db) =>
				db
					.select({ last: max(sessionEvent.sequence) })
					.from(sessionEvent)
					.where(eq(sessionEvent.sessionId, sessionId)),
			);
			const first = (stored?.last ?? -1) + 1;
			const createdAt = yield* nowIso;
			const values = yield* Effect.forEach(closing, (event, index) =>
				Effect.map(newId, (id) => ({
					id,
					sessionId,
					sequence: first + index,
					type: event.type,
					payload: event,
					createdAt,
				})),
			);
			yield* database.query((db) => db.insert(sessionEvent).values(values));
		}, Effect.provide(services));

		// Startup recovery: a restart cut off every turn that was running or waiting for an approval.
		const recoverSessions = Effect.gen(function* () {
			const updatedAt = yield* nowIso;
			const cutOff = yield* database.query((db) =>
				db
					.update(agentSession)
					.set({ status: "interrupted", updatedAt })
					.where(inArray(agentSession.status, ["running", "awaitingApproval"]))
					.returning({ id: agentSession.id }),
			);
			if (cutOff.length > 0) {
				yield* Effect.logInfo("Marked sessions cut off by a restart as interrupted").pipe(
					Effect.annotateLogs({ count: cutOff.length }),
				);
			}
			yield* Effect.forEach(cutOff, ({ id }) => closeCutOffHistory(id), { discard: true });
		});
		yield* recoverSessions;

		// Stop the idle sweep first, then release every remaining runtime while consumers can still save events.
		yield* Effect.addFinalizer(() => stopRuntimes(() => true));
		yield* stopExpiredRuntimes.pipe(Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)), Effect.forkScoped);

		// A running agent keeps the project settings and full access it started with, so losing trust stops it.
		// The next message starts it again as untrusted.
		const stopProject = Effect.fnUntraced(
			function* (projectId: string) {
				const rows = yield* database.query((db) =>
					db.select({ id: workspace.id }).from(workspace).where(eq(workspace.projectId, projectId)),
				);
				const workspaceIds = new Set(rows.map(({ id }) => id));
				yield* stopRuntimes((runtime) => workspaceIds.has(runtime.workspaceId));
			},
			Effect.catch((error) => Effect.logError("Could not stop the agents of a project that lost its trust", error)),
		);
		yield* projects.trustRevoked.pipe(Stream.runForEach(stopProject), Effect.forkScoped);

		return {
			listAgents,
			setApiKey,
			setAuthMode,
			startLogin,
			submitLoginCode,
			removeApiKey,
			// Both can start work in the workspace, so neither may race an archive of it.
			create: (input: Parameters<typeof create>[0]) => workspaceLock.starting(input.workspaceId, create(input)),
			list,
			rename,
			updateSettings,
			sendMessage: (...args: Parameters<typeof sendMessage>) =>
				Effect.flatMap(getRow(args[0]), (row) => workspaceLock.starting(row.workspaceId, sendMessage(...args))),
			// It can start the agent, so like sendMessage it may not race an archive.
			listCommands: (sessionId: string) =>
				Effect.flatMap(getRow(sessionId), (row) => workspaceLock.starting(row.workspaceId, listCommands(sessionId))),
			previewRevert,
			// It rewrites the workspace's files, so it may not race an archive of it, or a send from another chat.
			revertToMessage: (sessionId: string, messageId: string) =>
				Effect.flatMap(getRow(sessionId), (row) =>
					workspaceLock.rewriting(row.workspaceId, revertToMessage(sessionId, messageId)),
				),
			respondToApproval,
			// It can send the next message, so like sendMessage it may not race an archive.
			respondToPlan: (...args: Parameters<typeof respondToPlan>) =>
				Effect.flatMap(getRow(args[0]), (row) => workspaceLock.starting(row.workspaceId, respondToPlan(...args))),
			answerQuestion,
			interrupt,
			stop,
			stopWorkspace,
			deleteWorkspaceAttachments,
			getAttachment,
			history,
			subscribe,
			watch,
			watchLogins: Stream.fromPubSub(agentLogins),
		};
	}),
}) {
	static readonly layer = Layer.effect(SessionService, SessionService.make);
}
