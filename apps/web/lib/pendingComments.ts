import type { DiffComment } from "./diffComments.ts";

// Comments outlive the diff panel, so switching tabs and back keeps them until they are sent. A workspace's entry
// goes once it has none, and with its workspace when that is archived or removed.
const comments = new Map<string, ReadonlyArray<DiffComment>>();

const none: ReadonlyArray<DiffComment> = [];

export const commentsOf = (workspaceId: string) => comments.get(workspaceId) ?? none;

export const keepComments = (workspaceId: string, kept: ReadonlyArray<DiffComment>) => {
	if (kept.length === 0) comments.delete(workspaceId);
	else comments.set(workspaceId, kept);
};

export const releaseComments = (workspaceIds: Iterable<string>) => {
	for (const workspaceId of workspaceIds) comments.delete(workspaceId);
};
