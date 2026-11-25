import devChatTurns from "./fixtures/devChatTurns.json" with { type: "json" };
import { makeReplayAdapter } from "../agents/replay/ReplayAdapter.ts";
import { testAgentServices } from "./testAgentServices.ts";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { Effect, Layer, Redacted, Schema } from "effect";
import { AgentEvent } from "@repo/contracts/AgentEvent";
import { runDaemon } from "../server/runDaemon.ts";

// The real daemon with agents that replay recorded turns, for UI work without agent CLIs or keys.
// Run it with `bun run dev:replay`. It makes a fresh token and prints the URL to give the web dev server.
const turns = Schema.decodeUnknownSync(Schema.Array(Schema.Array(AgentEvent)))(devChatTurns);

const PrintDaemonUrl = Layer.effectDiscard(
	Effect.gen(function* () {
		const { port, token } = yield* DaemonConfig;
		yield* Effect.logInfo(
			`NEXT_PUBLIC_OCTOPUS_DAEMON_URL="ws://127.0.0.1:${port}/rpc?token=${Redacted.value(token)}" bun run --cwd apps/web dev`,
		);
	}),
).pipe(Layer.provideMerge(DaemonConfig.devLayer));

runDaemon(
	testAgentServices({
		claude: makeReplayAdapter({ kind: "claude", nativeSessionId: "dev-claude", turns }),
		codex: makeReplayAdapter({ kind: "codex", nativeSessionId: "dev-codex", turns }),
	}),
	PrintDaemonUrl,
);
