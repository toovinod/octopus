import { Context, Effect, Layer, Option, Redacted, Schema, SynchronizedRef } from "effect";
import type { AgentKind } from "@repo/contracts/AgentSession";

export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()("CredentialStoreError", {
	cause: Schema.Defect(),
}) {}

// One OS keychain entry per agent, named after the agent kind.
const KEYCHAIN_SERVICE = "app.octopus.agent";

export type KeychainSecrets = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

type ApiKey = Option.Option<Redacted.Redacted<string>>;

// macOS can ask the user to allow every keychain read, and asks again whenever the daemon binary
// changes, so each key is read once per run and kept here. Reads are serialized, so requests that
// arrive while the user is still answering wait for that answer instead of asking again.
export const makeCredentialStore = Effect.fnUntraced(function* (secrets: KeychainSecrets) {
	const keychain = <A>(run: () => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: (cause) => new CredentialStoreError({ cause }) });
	const known = yield* SynchronizedRef.make(new Map<AgentKind, ApiKey>());
	const remember = (agent: AgentKind, apiKey: ApiKey) =>
		SynchronizedRef.update(known, (current) => new Map(current).set(agent, apiKey));

	return CredentialStore.of({
		get: (agent) =>
			SynchronizedRef.modifyEffect(known, (current) => {
				const cached = current.get(agent);
				if (cached !== undefined) return Effect.succeed([cached, current] as const);
				return keychain(() => secrets.get({ service: KEYCHAIN_SERVICE, name: agent })).pipe(
					Effect.map((value) => {
						const apiKey = Option.map(Option.fromNullishOr(value), Redacted.make);
						return [apiKey, new Map(current).set(agent, apiKey)] as const;
					}),
				);
			}),
		set: (agent, apiKey) =>
			keychain(() => secrets.set({ service: KEYCHAIN_SERVICE, name: agent, value: Redacted.value(apiKey) })).pipe(
				Effect.andThen(remember(agent, Option.some(apiKey))),
			),
		remove: (agent) =>
			keychain(() => secrets.delete({ service: KEYCHAIN_SERVICE, name: agent })).pipe(
				Effect.andThen(remember(agent, Option.none())),
			),
	});
});

// Agent API keys. They stay Redacted everywhere in the daemon and never reach the database or logs.
export class CredentialStore extends Context.Service<
	CredentialStore,
	{
		get(agent: AgentKind): Effect.Effect<ApiKey, CredentialStoreError>;
		set(agent: AgentKind, apiKey: Redacted.Redacted<string>): Effect.Effect<void, CredentialStoreError>;
		remove(agent: AgentKind): Effect.Effect<void, CredentialStoreError>;
	}
>()("octopus/daemon/agents/CredentialStore") {
	static readonly layer = Layer.effect(CredentialStore, makeCredentialStore(Bun.secrets));
}
