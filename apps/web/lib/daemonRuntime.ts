import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { DaemonClient } from "@repo/contracts/DaemonClient";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logWarning } from "./logWarning.ts";

const DaemonConnection = Schema.Struct({
	url: Schema.String,
	token: Schema.String,
});

// The shell rejects with the daemon's own reason when it printed one before it stopped.
const isReason = Schema.is(Schema.String);

export class DaemonConnectionError extends Schema.TaggedError<DaemonConnectionError>()("DaemonConnectionError", {
	cause: Schema.Defect(),
}) {
	override get message() {
		return isReason(this.cause) ? this.cause : "Octopus could not reach its daemon.";
	}
}

// Outside the desktop shell (a browser during development) the daemon URL comes from the build environment,
// for example the URL that `bun run dev:replay` prints (see apps/web/README.md).
const devDaemonUrl = process.env.NEXT_PUBLIC_OCTOPUS_DAEMON_URL;

const DaemonClientFromShell = Layer.unwrap(
	Effect.gen(function* () {
		if (!isTauri() && devDaemonUrl !== undefined) {
			return DaemonClient.layer(devDaemonUrl);
		}
		const raw = yield* Effect.tryPromise({
			try: () => invoke<unknown>("daemon_connection"),
			catch: (cause) => new DaemonConnectionError({ cause }),
		});
		const { url, token } = yield* Schema.decodeUnknownEffect(DaemonConnection)(raw);
		return DaemonClient.layer(`${url.replace(/^http/, "ws")}/rpc?token=${encodeURIComponent(token)}`);
	}),
);

const daemonRuntime = ManagedRuntime.make(DaemonClientFromShell);

// Must match DAEMON_STOPPED_EVENT in apps/desktop/src-tauri/src/lib.rs.
const DAEMON_STOPPED_EVENT = "daemon-stopped";

// Must match StoppedDaemon in apps/desktop/src-tauri/src/lib.rs. The shell answers null while the daemon runs.
const isStoppedDaemon = Schema.is(Schema.Struct({ reason: Schema.NullOr(Schema.String) }));

export { isReason };

// Calls back when the desktop shell's daemon exits without the app quitting, with the daemon's own reason when it
// printed one. The event fires once, possibly before this listens, so the shell is asked once listening has begun.
// Returns the function that stops listening.
export const onDaemonStopped = (listener: (reason: string | null) => void) => {
	if (!isTauri()) return () => {};
	const unlisten = listen<unknown>(DAEMON_STOPPED_EVENT, (event) =>
		listener(isReason(event.payload) ? event.payload : null),
	);
	void unlisten
		.then(() => invoke<unknown>("daemon_stopped"))
		.then(
			(stopped) => {
				if (isStoppedDaemon(stopped)) listener(stopped.reason);
			},
			(error: unknown) => logWarning("Could not ask the desktop shell whether the daemon stopped", error),
		);
	return () => {
		void unlisten.then((stop) => stop());
	};
};

// The new daemon has a new URL and token. Reloading the window rebuilds the runtime, every stream and every list
// against it, so nothing keeps talking to the daemon that is gone. In a browser there is no shell to restart it,
// so a reload only tries the connection again.
export const restartDaemon = () =>
	isTauri() ? invoke("restart_daemon").then(() => window.location.reload()) : Promise.resolve(window.location.reload());

export type Daemon = DaemonClient["Service"];

// The one door from React to the daemon: components pass a function of the client and get a promise.
export const callDaemon = <A, E>(call: (daemon: Daemon) => Effect.Effect<A, E>): Promise<A> =>
	daemonRuntime.runPromise(Effect.flatMap(DaemonClient, call));

export interface Follow<A> {
	readonly onItem: (item: A) => void;
	// Called once when the stream ends: with null when it finished, or with the failure.
	readonly onEnd?: (error: unknown) => void;
}

// Runs a daemon stream until the returned function is called.
export const followDaemon = <A, E>(open: (daemon: Daemon) => Stream.Stream<A, E>, follow: Follow<A>) => {
	const fiber = daemonRuntime.runFork(
		Effect.flatMap(DaemonClient, (daemon) =>
			Stream.runForEach(open(daemon), (item) => Effect.sync(() => follow.onItem(item))),
		),
	);
	fiber.addObserver((exit) => {
		if (Exit.isSuccess(exit)) {
			follow.onEnd?.(null);
		} else if (!Cause.hasInterruptsOnly(exit.cause)) {
			follow.onEnd?.(Cause.squash(exit.cause));
		}
	});
	return () => {
		daemonRuntime.runFork(Fiber.interrupt(fiber));
	};
};

export { errorMessage, errorTag } from "./errorMessage.ts";
