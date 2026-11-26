import { HttpEffect, HttpMiddleware, HttpServerRequest } from "effect/http";
import { Config, Effect, Option, Ref, Result, Schema } from "effect";
import { CLIENT_ADDRESS_HEADER } from "@repo/auth/createAuth";
import { IpNetwork } from "effect/net";

const IpRange = Schema.Trim.check(
	Schema.makeFilter(
		(input: string) =>
			Result.isSuccess(IpNetwork.fromString(input)) ||
			"expected an IP range in CIDR notation, such as 10.0.0.0/8, or 203.0.113.7/32 for one address",
	),
);

// The proxies in front of the API. Empty means the API is reached directly.
export const trustedProxiesConfig = Config.Array(IpRange, "API_TRUSTED_PROXIES").pipe(
	Config.map((ranges) => ranges.map(IpNetwork.fromStringUnsafe)),
	Config.withDefault([]),
);

const withClientAddress = (request: Request, clientAddress: Option.Option<string>) => {
	const headers = new Headers(request.headers);
	headers.delete(CLIENT_ADDRESS_HEADER);
	if (Option.isSome(clientAddress)) headers.set(CLIENT_ADDRESS_HEADER, clientAddress.value);
	return new Request(request, { headers });
};

// Behind a proxy that is not listed, every request comes from the proxy's address, so all clients share
// one rate limit bucket and one busy client locks everyone out. Warn once, on the first forwarded request.
const warnOnceIfProxyUntrusted = Effect.fnUntraced(function* (warned: Ref.Ref<boolean>) {
	if (yield* Ref.getAndSet(warned, true)) return;
	yield* Effect.logWarning(
		"A request carried X-Forwarded-For but API_TRUSTED_PROXIES is empty, so rate limits count every client behind that proxy as one. If the API runs behind a proxy, set API_TRUSTED_PROXIES to its address ranges.",
	);
});

// Builds a server app that runs a web handler, which reads the client's address from CLIENT_ADDRESS_HEADER, for rate limits.
// The address is the socket peer, or, when that peer is a trusted proxy, the first address in
// X-Forwarded-For that is not one. Any value the client sent itself is dropped, so it cannot pick its bucket.
export const serveWithClientAddress = Effect.fn("serveWithClientAddress")(function* (
	trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
	handler: (request: Request) => Promise<Response>,
) {
	const warned = yield* Ref.make(false);
	return HttpServerRequest.HttpServerRequest.use((request) =>
		Effect.gen(function* () {
			if (trustedProxies.length === 0 && request.headers["x-forwarded-for"] !== undefined) {
				yield* warnOnceIfProxyUntrusted(warned);
			}
			return yield* HttpEffect.fromWebHandler((webRequest) =>
				handler(withClientAddress(webRequest, request.remoteAddress)),
			);
		}),
	).pipe(HttpMiddleware.xForwardedHeaders({ trustedProxies }));
});
