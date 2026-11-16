import { type CredentialStore, type KeychainSecrets, makeCredentialStore } from "./CredentialStore.ts";
import { describe, expect, test } from "bun:test";
import { Effect, Option, Redacted } from "effect";

// A keychain that counts reads, as macOS may ask the user for every one of them.
const fakeKeychain = (initial: Record<string, string> = {}) => {
	const values = new Map(Object.entries(initial));
	let reads = 0;
	let locked = false;
	const secrets: KeychainSecrets = {
		get: async ({ name }) => {
			reads++;
			if (locked) throw new Error("User interaction is not allowed.");
			return values.get(name) ?? null;
		},
		set: async ({ name, value }) => {
			values.set(name, value);
		},
		delete: async ({ name }) => values.delete(name),
	};
	return { secrets, reads: () => reads, lock: (value: boolean) => (locked = value) };
};

const run = <A, E>(
	keychain: ReturnType<typeof fakeKeychain>,
	use: (store: typeof CredentialStore.Service) => Effect.Effect<A, E>,
) => Effect.runPromise(Effect.flatMap(makeCredentialStore(keychain.secrets), use));

const reveal = (value: Option.Option<Redacted.Redacted<string>>) => Option.getOrNull(Option.map(value, Redacted.value));

describe("CredentialStore", () => {
	test("reads each agent's key from the keychain once", async () => {
		const keychain = fakeKeychain({ claude: "sk-ant-1" });
		const keys = await run(keychain, (store) =>
			Effect.all([store.get("claude"), store.get("claude"), store.get("codex"), store.get("codex")], {
				concurrency: "unbounded",
			}),
		);
		expect(keys.map(reveal)).toEqual(["sk-ant-1", "sk-ant-1", null, null]);
		expect(keychain.reads()).toBe(2);
	});

	test("a saved or removed key is seen without reading the keychain again", async () => {
		const keychain = fakeKeychain({ claude: "sk-ant-1" });
		const keys = await run(keychain, (store) =>
			Effect.gen(function* () {
				const before = yield* store.get("claude");
				yield* store.set("claude", Redacted.make("sk-ant-2"));
				const saved = yield* store.get("claude");
				yield* store.remove("claude");
				const removed = yield* store.get("claude");
				return [before, saved, removed];
			}),
		);
		expect(keys.map(reveal)).toEqual(["sk-ant-1", "sk-ant-2", null]);
		expect(keychain.reads()).toBe(1);
	});

	test("a denied read is tried again next time", async () => {
		const keychain = fakeKeychain({ claude: "sk-ant-1" });
		const result = await run(keychain, (store) =>
			Effect.gen(function* () {
				keychain.lock(true);
				const denied = yield* Effect.flip(store.get("claude"));
				keychain.lock(false);
				return { denied: denied._tag, key: reveal(yield* store.get("claude")) };
			}),
		);
		expect(result).toEqual({ denied: "CredentialStoreError", key: "sk-ant-1" });
		expect(keychain.reads()).toBe(2);
	});
});
