import type { DraftImage } from "./images.ts";

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
