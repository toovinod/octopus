import type { ImageData } from "@repo/contracts/AgentSession";
import { type DraftImage, draftImageOf } from "./images.ts";

export interface Draft {
	readonly text: string;
	readonly images: ReadonlyArray<DraftImage>;
}

const emptyDraft: Draft = { text: "", images: [] };

// Drafts outlive the composer, so switching chats and back keeps what was typed. Images can be megabytes each, so a
// draft goes as soon as it is empty, and with its images when its chat's workspace is archived or removed.
const drafts = new Map<string, Draft>();

export const draftOf = (sessionId: string) => drafts.get(sessionId) ?? emptyDraft;

export const keepDraft = (sessionId: string, draft: Draft) => {
	if (draft.text === "" && draft.images.length === 0) drafts.delete(sessionId);
	else drafts.set(sessionId, draft);
};

export const releaseDrafts = (sessionIds: Iterable<string>) => {
	for (const sessionId of sessionIds) {
		for (const image of drafts.get(sessionId)?.images ?? []) URL.revokeObjectURL(image.previewUrl);
		drafts.delete(sessionId);
	}
};

// Adds images up to the limit, revoking the previews of those left out. Two pastes read at the same time each see
// room for themselves, so the limit is applied here, to the draft they land in.
export const addImages = (draft: Draft, images: ReadonlyArray<DraftImage>, max: number) => {
	const room = Math.max(0, max - draft.images.length);
	for (const image of images.slice(room)) URL.revokeObjectURL(image.previewUrl);
	return {
		draft: { ...draft, images: [...draft.images, ...images.slice(0, room)] },
		leftOut: Math.max(0, images.length - room),
	};
};

// Queued messages a stop handed back never ran, so they go ahead of what is being typed, to be edited or sent again.
export const withReturned = (
	draft: Draft,
	returned: ReadonlyArray<{ readonly text: string; readonly images: ReadonlyArray<ImageData> }>,
	max: number,
) => {
	const images = returned.flatMap((message) => message.images);
	const room = Math.max(0, max - draft.images.length);
	return {
		draft: {
			text: [...returned.map(({ text }) => text), draft.text].filter((text) => text !== "").join("\n\n"),
			images: [...images.slice(0, room).map(draftImageOf), ...draft.images],
		},
		leftOut: Math.max(0, images.length - room),
	};
};
