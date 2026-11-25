import { Config, Context, Effect, Layer, Option, Redacted, Schema, Sink, Stdio, Stream } from "effect";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

class DaemonTokenMissingError extends Schema.TaggedError<DaemonTokenMissingError>()("DaemonTokenMissingError", {}) {
	override get message() {
		return "octopusd reads its token from the first line of stdin. Start it from the Octopus app.";
	}
}

// The desktop shell writes the token on stdin rather than in the environment, because every
// agent, script and git process the daemon starts inherits its environment. It keeps stdin open
// afterwards, and the OS closes it when the shell exits for any reason, including a crash.
const readStdin = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio;
	const [firstLine, rest] = yield* stdio.stdin.pipe(
		Stream.decodeText(),
		Stream.splitLines,
		Stream.peel(Sink.head()),
		Effect.orDie,
	);
	const token = Option.getOrElse(firstLine, () => "").trim();
	if (token === "") {
		return yield* new DaemonTokenMissingError();
	}
	return { token: Redacted.make(token), parentExited: Effect.orDie(Stream.runDrain(rest)) };
});

// The pages the desktop shell serves the web app from: tauri://localhost on macOS and Linux, http://tauri.localhost on Windows.
export const TAURI_ORIGINS = ["tauri://localhost", "http://tauri.localhost"];

// The dev daemon makes its own token, prints it and listens on a known port next to the web dev server.
const randomToken = Effect.sync(() => ({
	token: Redacted.make(randomBytes(32).toString("hex")),
	parentExited: Effect.never,
}));

const readConfig = Effect.fn("readConfig")(function* <E, R>(
	credentials: Effect.Effect<
		{ readonly token: Redacted.Redacted<string>; readonly parentExited: Effect.Effect<void> },
		E,
		R
	>,
	defaults: { readonly port: number; readonly devOrigin: Option.Option<string> },
) {
	const port = yield* Config.Port("OCTOPUS_DAEMON_PORT").pipe(Config.withDefault(defaults.port));
	const { token, parentExited } = yield* credentials;
	const dataDir = yield* Config.String("OCTOPUS_DATA_DIR").pipe(Config.withDefault(join(homedir(), ".octopus")));
	// Set by a debug build of the desktop shell, whose window loads the web dev server instead of tauri://localhost.
	const devOrigin = yield* Config.option(Config.String("OCTOPUS_DAEMON_DEV_ORIGIN"));
	const allowedOrigins = [...TAURI_ORIGINS, ...Option.toArray(Option.orElse(devOrigin, () => defaults.devOrigin))];
	return { port, token, dataDir, allowedOrigins, parentExited };
});

export class DaemonConfig extends Context.Service<
	DaemonConfig,
	{
		readonly port: number;
		readonly token: Redacted.Redacted<string>;
		readonly dataDir: string;
		// Browsers send the page's Origin on a WebSocket and apply no CORS to it, so the daemon checks it itself.
		readonly allowedOrigins: ReadonlyArray<string>;
		// Completes when stdin closes, which means the app that started the daemon is gone.
		readonly parentExited: Effect.Effect<void>;
	}
>()("octopus/daemon/config/DaemonConfig") {
	static readonly layer = Layer.effect(DaemonConfig, readConfig(readStdin, { port: 0, devOrigin: Option.none() }));

	static readonly devLayer = Layer.effect(
		DaemonConfig,
		readConfig(randomToken, { port: 4799, devOrigin: Option.some("http://localhost:3000") }),
	);
}
