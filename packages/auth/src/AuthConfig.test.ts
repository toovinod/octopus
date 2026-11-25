import { ConfigProvider, Effect, Layer } from "effect";
import { describe, expect, test } from "bun:test";
import { AuthConfig } from "./AuthConfig.ts";

const required = {
	BETTER_AUTH_URL: "http://localhost:3001",
	WEB_ORIGIN: "http://localhost:3000",
	BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
	DATABASE_URL: "postgres://localhost/test",
	GITHUB_CLIENT_ID: "test",
	GITHUB_CLIENT_SECRET: "test",
	GOOGLE_CLIENT_ID: "test",
	GOOGLE_CLIENT_SECRET: "test",
};

const ipAddressHeaderWith = (env: Record<string, string>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { ipAddressHeader } = yield* AuthConfig;
			return ipAddressHeader;
		}).pipe(
			Effect.provide(
				AuthConfig.layer.pipe(
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...required, ...env } }))),
				),
			),
		),
	);

describe("AuthConfig", () => {
	test("reads the client address from x-forwarded-for when the header is not set", async () => {
		expect(await ipAddressHeaderWith({})).toBe("x-forwarded-for");
	});

	test("treats an empty header, as a copied .env.example leaves it, as not set", async () => {
		expect(await ipAddressHeaderWith({ AUTH_IP_ADDRESS_HEADER: "" })).toBe("x-forwarded-for");
	});

	test("reads the header the proxy sets", async () => {
		expect(await ipAddressHeaderWith({ AUTH_IP_ADDRESS_HEADER: "cf-connecting-ip" })).toBe("cf-connecting-ip");
	});
});
