import { serveWithClientAddress, trustedProxiesConfig } from "./serveWithClientAddress.ts";
import { ConfigProvider, Effect, Logger, Option, Result } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { CLIENT_ADDRESS_HEADER } from "@repo/auth/createAuth";
import { describe, expect, test } from "bun:test";
import { IpNetwork } from "effect/net";

// Answers with the client address the wrapped handler was given.
const echoClientAddress = (request: Request) =>
	Promise.resolve(Response.json({ clientAddress: request.headers.get(CLIENT_ADDRESS_HEADER) }));

const requestFrom = (peer: string, headers?: Record<string, string>) =>
	HttpServerRequest.fromWeb(new Request("http://api.test/api/auth/ok", { headers })).modify({
		remoteAddress: Option.some(peer),
	});

const clientAddressSeen = (options: {
	readonly trustedProxies: ReadonlyArray<string>;
	readonly peer: string;
	readonly headers?: Record<string, string>;
}) =>
	serveWithClientAddress(options.trustedProxies.map(IpNetwork.fromStringUnsafe), echoClientAddress).pipe(
		Effect.flatMap((app) =>
			app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, requestFrom(options.peer, options.headers))),
		),
		Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).json())),
		Effect.runPromise,
	);

// Serves the requests in order through one server and returns the warnings it logged.
const warningsServing = (trustedProxies: ReadonlyArray<string>, requests: ReadonlyArray<Record<string, string>>) => {
	const warnings: Array<unknown> = [];
	const captureWarnings = Logger.make(({ logLevel, message }) => {
		if (logLevel === "Warn") warnings.push(message);
	});
	return Effect.gen(function* () {
		const app = yield* serveWithClientAddress(trustedProxies.map(IpNetwork.fromStringUnsafe), echoClientAddress);
		for (const headers of requests) {
			yield* app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, requestFrom("10.0.0.2", headers)));
		}
		return warnings;
	}).pipe(Effect.provide(Logger.layer([captureWarnings])), Effect.runPromise);
};

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

describe("serveWithClientAddress behind an unconfigured proxy", () => {
	test("warns once when requests carry X-Forwarded-For but no proxy is trusted, since every client then shares one rate limit", async () => {
		const forwarded = { "x-forwarded-for": "198.51.100.7" };
		const warnings = await warningsServing([], [{}, forwarded, forwarded]);
		expect(warnings).toHaveLength(1);
		expect(String(warnings[0])).toContain("API_TRUSTED_PROXIES");
	});

	test("stays quiet without X-Forwarded-For, or when the proxies are configured", async () => {
		expect(await warningsServing([], [{}, {}])).toEqual([]);
		expect(await warningsServing(["10.0.0.0/8"], [{ "x-forwarded-for": "198.51.100.7" }])).toEqual([]);
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
