import { DaemonConfig } from "../config/DaemonConfig.ts";
import { Effect, Layer, Redacted } from "effect";

// 32 bytes as hex, the shape of the token the desktop shell sends.
export const TEST_TOKEN = "0123456789abcdef".repeat(4);
export const TEST_ORIGIN = "tauri://localhost";

export const testDaemonConfig = (dataDir: string) =>
	Layer.succeed(
		DaemonConfig,
		DaemonConfig.of({
			port: 0,
			token: Redacted.make(TEST_TOKEN),
			dataDir,
			allowedOrigins: [TEST_ORIGIN],
			parentExited: Effect.never,
		}),
	);
