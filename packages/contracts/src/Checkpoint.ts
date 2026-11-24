import { Schema } from "effect";

// A file that changed since a message's checkpoint. Reverting undoes the change.
export const CheckpointChange = Schema.Struct({
	path: Schema.String,
	change: Schema.Literals(["added", "modified", "deleted"]),
});
export type CheckpointChange = typeof CheckpointChange.Type;

export class CheckpointNotFoundError extends Schema.TaggedError<CheckpointNotFoundError>()("CheckpointNotFoundError", {
	sessionId: Schema.String,
	messageId: Schema.String,
}) {
	override get message() {
		return "This message has no checkpoint, since it was sent before Octopus saved them. Pick a later message.";
	}
}

export class WorkspaceAgentsBusyError extends Schema.TaggedError<WorkspaceAgentsBusyError>()(
	"WorkspaceAgentsBusyError",
	{ workspaceId: Schema.String },
) {
	override get message() {
		return "An agent is still working in this workspace. Stop it, then revert.";
	}
}
