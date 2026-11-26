import { HttpEffect, HttpMiddleware, HttpServerRequest } from "effect/http";
import { CLIENT_ADDRESS_HEADER } from "@repo/auth/createAuth";
import { Config, Option, Result, Schema } from "effect";
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

// Serves a web handler that reads the client's address from CLIENT_ADDRESS_HEADER, for rate limits.
// The address is the socket peer, or, when that peer is a trusted proxy, the first address in
// X-Forwarded-For that is not one. Any value the client sent itself is dropped, so it cannot pick its bucket.
export const serveWithClientAddress = (
	trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>,
	handler: (request: Request) => Promise<Response>,
) =>
	HttpServerRequest.HttpServerRequest.use((request) =>
		HttpEffect.fromWebHandler((webRequest) => handler(withClientAddress(webRequest, request.remoteAddress))),
	).pipe(HttpMiddleware.xForwardedHeaders({ trustedProxies }));
