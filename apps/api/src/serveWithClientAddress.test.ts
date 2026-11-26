import { serveWithClientAddress, trustedProxiesConfig } from "./serveWithClientAddress.ts";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { ConfigProvider, Effect, Option, Result } from "effect";
import { CLIENT_ADDRESS_HEADER } from "@repo/auth/createAuth";
import { describe, expect, test } from "bun:test";
import { IpNetwork } from "effect/net";

// Answers with the client address the wrapped handler was given.
const echoClientAddress = (request: Request) =>
	Promise.resolve(Response.json({ clientAddress: request.headers.get(CLIENT_ADDRESS_HEADER) }));

const clientAddressSeen = (options: {
	readonly trustedProxies: ReadonlyArray<string>;
	readonly peer: string;
	readonly headers?: Record<string, string>;
}) =>
	serveWithClientAddress(options.trustedProxies.map(IpNetwork.fromStringUnsafe), echoClientAddress).pipe(
		Effect.provideService(
			HttpServerRequest.HttpServerRequest,
			HttpServerRequest.fromWeb(new Request("http://api.test/api/auth/ok", { headers: options.headers })).modify({
				remoteAddress: Option.some(options.peer),
			}),
		),
		Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).json())),
		Effect.runPromise,
	);

const trustedProxiesFrom = (value: string | undefined) =>
	Effect.runPromise(
		Effect.result(
			trustedProxiesConfig.parse(
				ConfigProvider.fromEnv({ env: value === undefined ? {} : { API_TRUSTED_PROXIES: value } }),
			),
		),
	).then(Result.map((networks) => networks.map(IpNetwork.format)));

describe("serveWithClientAddress", () => {
	test("exposed directly, uses the socket address and drops whatever address headers the client sent", async () => {
		const seen = await clientAddressSeen({
			trustedProxies: [],
			peer: "198.51.100.7",
			headers: { "x-forwarded-for": "6.6.6.6", [CLIENT_ADDRESS_HEADER]: "6.6.6.6" },
		});
		expect(seen).toEqual({ clientAddress: "198.51.100.7" });
	});

	test("behind a trusted proxy, uses the first address in X-Forwarded-For that is not a proxy", async () => {
		const seen = await clientAddressSeen({
			trustedProxies: ["10.0.0.0/8"],
			peer: "10.0.0.2",
			headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.1" },
		});
		expect(seen).toEqual({ clientAddress: "198.51.100.7" });
	});

	test("ignores X-Forwarded-For sent straight to the API by a peer that is not a trusted proxy", async () => {
		const seen = await clientAddressSeen({
			trustedProxies: ["10.0.0.0/8"],
			peer: "203.0.113.9",
			headers: { "x-forwarded-for": "198.51.100.7" },
		});
		expect(seen).toEqual({ clientAddress: "203.0.113.9" });
	});
});

describe("trustedProxiesConfig", () => {
	test("trusts no proxy when unset or empty, as a copied .env.example leaves it", async () => {
		expect(await trustedProxiesFrom(undefined)).toEqual(Result.succeed([]));
		expect(await trustedProxiesFrom("")).toEqual(Result.succeed([]));
	});

	test("reads a comma-separated list of CIDR ranges", async () => {
		expect(await trustedProxiesFrom("10.0.0.0/8, 2001:db8::/32")).toEqual(
			Result.succeed(["10.0.0.0/8", "2001:db8::/32"]),
		);
	});

	test("refuses an address without a prefix length, so a typo cannot silently trust nobody", async () => {
		expect(Result.isFailure(await trustedProxiesFrom("10.0.0.1"))).toBe(true);
	});
});
