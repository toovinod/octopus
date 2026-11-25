import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { DaemonConfig } from "../config/DaemonConfig.ts";
import { Effect, Layer, Redacted, Schema } from "effect";
import { timingSafeEqual } from "node:crypto";
import { RpcServer } from "effect/rpc";

const RpcConnectionParams = Schema.Struct({ token: Schema.String });

const unauthorized = HttpServerResponse.empty({ status: 401 });
const forbidden = HttpServerResponse.empty({ status: 403 });

// Constant-time comparison so the token cannot be guessed from response timing.
const isDaemonToken = (candidate: string, expected: Redacted.Redacted<string>) => {
	const candidateBytes = Buffer.from(candidate);
	const expectedBytes = Buffer.from(Redacted.value(expected));
	return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
};

// Browsers cannot set headers on a WebSocket, so the token travels as `?token=`.
// Browsers do send Origin and apply no CORS to WebSockets, so a page is refused unless it is the app's own. A request
// without Origin comes from a local program, not a page. Host must be our own address, so DNS rebinding gets nowhere.
export const RpcWebSocketRoute = Layer.effect(
	RpcServer.Protocol,
	Effect.gen(function* () {
		const { token, allowedOrigins } = yield* DaemonConfig;
		const { address } = yield* HttpServer.HttpServer;
		const expectedHost = new URL(HttpServer.formatAddress(address)).host;
		const router = yield* HttpRouter.HttpRouter;
		const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;

		yield* router.add(
			"GET",
			"/rpc",
			Effect.gen(function* () {
				const { headers } = yield* HttpServerRequest.HttpServerRequest;
				if (headers.host !== expectedHost) {
					yield* Effect.logWarning("Refused an RPC connection for another host").pipe(
						Effect.annotateLogs({ host: headers.host, expectedHost }),
					);
					return forbidden;
				}
				if (headers.origin !== undefined && !allowedOrigins.includes(headers.origin)) {
					yield* Effect.logWarning("Refused an RPC connection from a page on another origin").pipe(
						Effect.annotateLogs({ origin: headers.origin, allowedOrigins: allowedOrigins.join(" ") }),
					);
					return forbidden;
				}
				const params = yield* HttpServerRequest.schemaSearchParams(RpcConnectionParams);
				if (!isDaemonToken(params.token, token)) {
					return unauthorized;
				}
				return yield* httpEffect;
			}).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(unauthorized))),
		);

		return protocol;
	}),
);
