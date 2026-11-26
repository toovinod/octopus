import { ImageData } from "@repo/contracts/AgentSession";
import { DiffComment } from "./diffComments.ts";
import { Effect, Schema } from "effect";

// Restarting the daemon reloads the window, which would lose what only lives in memory: drafts, unsent diff
// comments and messages the daemon refused. They go to sessionStorage, which lasts for this window only.
const Saved = Schema.Struct({
	drafts: Schema.Record(Schema.String, Schema.Struct({ text: Schema.String, images: Schema.Array(ImageData) })),
	comments: Schema.Record(Schema.String, Schema.Array(DiffComment)),
	failedSends: Schema.Record(
		Schema.String,
		Schema.Array(Schema.Struct({ text: Schema.String, images: Schema.Array(ImageData), error: Schema.String })),
	),
});
export type Saved = typeof Saved.Type;

const StoredSaved = Schema.fromJsonString(Saved);

const KEY = "octopus.keptAcrossReload";

type ReloadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const withoutImages = (saved: Saved): Saved => ({
	drafts: Object.fromEntries(Object.entries(saved.drafts).map(([id, draft]) => [id, { ...draft, images: [] }])),
	comments: saved.comments,
	failedSends: Object.fromEntries(
		Object.entries(saved.failedSends).map(([id, sends]) => [id, sends.map((send) => ({ ...send, images: [] }))]),
	),
});

// Read inside Effect.try, because touching sessionStorage throws where it is blocked or missing.
const storageOr = (storage: ReloadStorage | undefined) => storage ?? sessionStorage;

const write = (storage: ReloadStorage | undefined, saved: Saved) =>
	Effect.try(() => storageOr(storage).setItem(KEY, Schema.encodeSync(StoredSaved)(saved)));

// Images can pass the storage quota, so the text is kept without them rather than losing everything.
export const saveForReload = (saved: Saved, storage?: ReloadStorage) =>
	write(storage, saved).pipe(
		Effect.catch(() =>
			write(storage, withoutImages(saved)).pipe(
				Effect.tap(() => Effect.logWarning("Images in drafts did not fit in storage, so the reload drops them")),
			),
		),
		Effect.catch((cause) => Effect.logWarning("Could not keep drafts across the reload", cause)),
		Effect.runSync,
	);

// Read once: a later reload that saved nothing must not bring back what was already restored.
export const takeSavedForReload = (storage?: ReloadStorage): Saved | null =>
	Effect.try(() => {
		const raw = storageOr(storage).getItem(KEY);
		storageOr(storage).removeItem(KEY);
		return raw;
	}).pipe(
		Effect.flatMap(Effect.fromNullishOr),
		Effect.flatMap(Schema.decodeUnknownEffect(StoredSaved)),
		Effect.orElseSucceed(() => null),
		Effect.runSync,
	);
