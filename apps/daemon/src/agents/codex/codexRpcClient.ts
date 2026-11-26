import { type Cause, Context, Deferred, Duration, Effect, Queue, Result, Schema, Stream } from "effect";
import { type AgentError, AgentProcessError, AgentProtocolError } from "../AgentAdapter.ts";
import { type ChildProcess, ChildProcessSpawner } from "effect/process";
import { toAgentError } from "../toAgentError.ts";

// Codex app-server speaks JSON-RPC 2.0 without the "jsonrpc" field, one message per line.

const RequestId = Schema.Union([Schema.String, Schema.Number]);
export type RequestId = typeof RequestId.Type;

const IncomingMessage = Schema.Union([
	Schema.Struct({
		id: RequestId,
		method: Schema.String,
		params: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({
		method: Schema.String,
		params: Schema.optionalKey(Schema.Unknown),
	}),
	// A reply to a request Codex could not even parse has a null id.
	Schema.Struct({
		id: Schema.NullOr(RequestId),
		error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
	}),
	Schema.Struct({ id: RequestId, result: Schema.Unknown }),
]);
const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(IncomingMessage));

export type CodexIncoming =
	| {
			readonly _tag: "notification";
			readonly method: string;
			readonly params: unknown;
	  }
	| {
			readonly _tag: "request";
			readonly id: RequestId;
			readonly method: string;
			readonly params: unknown;
	  };

export interface CodexRpcClient {
	// Notifications and server requests, in order. Fails when the app-server exits.
	readonly incoming: Stream.Stream<CodexIncoming, AgentError>;
	request(method: string, params: unknown): Effect.Effect<unknown, AgentError>;
	notify(method: string): Effect.Effect<void>;
	respond(id: RequestId, result: unknown): Effect.Effect<void>;
	respondError(id: RequestId, code: number, message: string): Effect.Effect<void>;
}

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

export const CodexRequestSettings = Context.Reference<{
	// How long Codex may take to answer a request. Every app-server request is answered at once, turns
	// included: their work streams in as notifications, which have no deadline. A hung app-server then fails
	// the call instead of leaving the UI waiting forever.
	readonly timeout: Duration.Duration;
}>("octopus/daemon/agents/codex/CodexRequestSettings", {
	defaultValue: () => ({ timeout: Duration.seconds(30) }),
});
// Incoming messages wait here for the adapter. A full buffer pauses reading stdout.
const INCOMING_BUFFER = 256;

// Spawns `codex app-server` in the caller's scope. Closing the scope kills the process.
export const makeCodexRpcClient = Effect.fn("makeCodexRpcClient")(function* (command: ChildProcess.StandardCommand) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const handle = yield* spawner
		.spawn(command)
		.pipe(Effect.mapError(toAgentError(command.command, "Could not start Codex app-server.")));

	const outgoing = yield* Queue.unbounded<string>();
	const incoming = yield* Queue.bounded<CodexIncoming, AgentError | Cause.Done>(INCOMING_BUFFER);
	const pending = new Map<RequestId, Deferred.Deferred<unknown, AgentError>>();
	let nextId = 0;
	// Set once the app-server exits, so later calls fail at once instead of waiting out their deadline.
	let ended: AgentError | undefined;

	// Once the connection ended nothing more can reach Codex, so nothing more is queued for it.
	const send = (message: object) =>
		Effect.suspend(() =>
			ended === undefined ? Effect.asVoid(Queue.offer(outgoing, `${JSON.stringify(message)}\n`)) : Effect.void,
		);

	const exited = new AgentProcessError({
		message: "Codex app-server exited.",
		cause: null,
	});

	// Fails every waiting request and the incoming stream, so callers learn at once instead of at their deadlines.
	const end = (error: AgentError) =>
		Effect.gen(function* () {
			if (ended !== undefined) return;
			ended = error;
			for (const deferred of pending.values()) {
				yield* Deferred.fail(deferred, error);
			}
			pending.clear();
			yield* Queue.shutdown(outgoing);
			yield* Queue.fail(incoming, error);
		});

	const handleLine = (line: string) =>
		Effect.gen(function* () {
			if (line.trim() === "") return;
			// One line Octopus cannot read, like stray output from a newer Codex, must not end the session.
			const decoded = yield* Effect.result(decodeLine(line));
			if (Result.isFailure(decoded)) {
				return yield* Effect.logWarning("Skipping a line from Codex that Octopus could not read", decoded.failure);
			}
			const message = decoded.success;
			if ("method" in message) {
				yield* Queue.offer(
					incoming,
					"id" in message
						? {
								_tag: "request",
								id: message.id,
								method: message.method,
								params: message.params,
							}
						: {
								_tag: "notification",
								method: message.method,
								params: message.params,
							},
				);
				return;
			}
			if (message.id === null) {
				return yield* Effect.logWarning("Codex reported an error for no request").pipe(
					Effect.annotateLogs({ error: "error" in message ? message.error.message : "" }),
				);
			}
			const deferred = pending.get(message.id);
			if (deferred === undefined) {
				return yield* Effect.logWarning("Codex answered an unknown request").pipe(
					Effect.annotateLogs({ id: message.id }),
				);
			}
			pending.delete(message.id);
			if ("error" in message) {
				yield* Deferred.fail(
					deferred,
					new AgentProtocolError({
						message: `Codex rejected a request: ${message.error.message}`,
						cause: message.error,
					}),
				);
			} else {
				yield* Deferred.succeed(deferred, message.result);
			}
		});

	yield* Stream.fromQueue(outgoing).pipe(
		Stream.encodeText,
		Stream.run(handle.stdin),
		// A write that fails would drop every later request and answer, so the connection ends with it.
		Effect.catch((cause) =>
			Effect.logWarning("Writing to Codex failed", cause).pipe(
				Effect.andThen(
					end(
						new AgentProcessError({
							message: "Octopus could not write to Codex, so the chat stopped. Start it again.",
							cause,
						}),
					),
				),
			),
		),
		Effect.forkScoped,
	);

	yield* handle.stderr.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.runForEach((line) => Effect.logDebug("codex stderr", line)),
		Effect.ignore,
		Effect.forkScoped,
	);

	yield* handle.stdout.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.mapError((cause) => new AgentProcessError({ message: "Reading from Codex failed.", cause })),
		Stream.runForEach(handleLine),
		Effect.andThen(Effect.fail(exited)),
		Effect.catch(end),
		Effect.forkScoped,
	);

	return {
		incoming: Stream.fromQueue(incoming),
		request: (method, params) =>
			Effect.gen(function* () {
				if (ended !== undefined) return yield* Effect.fail(ended);
				const { timeout } = yield* CodexRequestSettings;
				const id = nextId++;
				const deferred = yield* Deferred.make<unknown, AgentError>();
				pending.set(id, deferred);
				return yield* send({ id, method, params }).pipe(
					Effect.andThen(Deferred.await(deferred)),
					Effect.timeoutOrElse({
						duration: timeout,
						orElse: () =>
							Effect.fail(
								new AgentProcessError({
									message: `Codex did not answer ${method} in time. Try again, and stop the chat if it keeps happening.`,
									cause: null,
								}),
							),
					}),
					// Also when the caller gives up, for example at a deadline, so a reply that never comes leaks nothing.
					Effect.ensuring(Effect.sync(() => pending.delete(id))),
				);
			}).pipe(Effect.withSpan("CodexRpcClient.request", { attributes: { method } })),
		notify: (method) => send({ method }),
		respond: (id, result) => send({ id, result }),
		respondError: (id, code, message) => send({ id, error: { code, message } }),
	} satisfies CodexRpcClient;
});
