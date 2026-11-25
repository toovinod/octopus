import { Schema } from "effect";

export const WorkspaceKind = Schema.Literals(["worktree", "inPlace"]);
export type WorkspaceKind = typeof WorkspaceKind.Type;

// Runtime activity (agents or scripts running) is derived, never stored here.
export const WorkspaceStatus = Schema.Literals(["active", "archived"]);
export type WorkspaceStatus = typeof WorkspaceStatus.Type;

// The name becomes the git branch and the worktree folder, so keep it to safe characters.
export const WorkspaceName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/));

export class Workspace extends Schema.Class<Workspace>("Workspace")({
	id: Schema.String,
	projectId: Schema.String,
	name: Schema.String,
	kind: WorkspaceKind,
	path: Schema.String,
	branch: Schema.String,
	baseBranch: Schema.String,
	status: WorkspaceStatus,
	pullRequestUrl: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	archivedAt: Schema.NullOr(Schema.String),
}) {}

export class WorkspaceNotFoundError extends Schema.TaggedError<WorkspaceNotFoundError>()("WorkspaceNotFoundError", {
	workspaceId: Schema.String,
}) {
	override get message() {
		return "This workspace no longer exists. Refresh the workspace list.";
	}
}

export class WorkspacePathInUseError extends Schema.TaggedError<WorkspacePathInUseError>()("WorkspacePathInUseError", {
	path: Schema.String,
}) {
	override get message() {
		return `An active workspace already uses ${this.path}. Archive it first or pick another name.`;
	}
}

export class BranchAlreadyExistsError extends Schema.TaggedError<BranchAlreadyExistsError>()(
	"BranchAlreadyExistsError",
	{ branch: Schema.String },
) {
	override get message() {
		return `The branch ${this.branch} already exists. Pick another workspace name.`;
	}
}

export class WorktreeCreateError extends Schema.TaggedError<WorktreeCreateError>()("WorktreeCreateError", {
	branch: Schema.String,
}) {
	override get message() {
		return `Octopus could not create a worktree for ${this.branch}. Check that the base branch exists and the repository is not locked.`;
	}
}

export class WorktreeRemoveError extends Schema.TaggedError<WorktreeRemoveError>()("WorktreeRemoveError", {
	path: Schema.String,
}) {
	override get message() {
		return `Octopus could not remove the worktree at ${this.path}. Close programs using it and try again.`;
	}
}

export class WorkspaceHasUnsavedWorkError extends Schema.TaggedError<WorkspaceHasUnsavedWorkError>()(
	"WorkspaceHasUnsavedWorkError",
	{
		workspaceId: Schema.String,
		changedFiles: Schema.Array(Schema.String),
		unpushedCommits: Schema.Int,
		// Files git ignores, such as .env. Archiving deletes them, even with force.
		ignoredFiles: Schema.Array(Schema.String),
	},
) {
	override get message() {
		const ignored =
			this.ignoredFiles.length === 0
				? ""
				: ` Archiving also deletes ${this.ignoredFiles.length} ignored file(s): ${this.ignoredFiles.slice(0, 5).join(", ")}.`;
		return `This workspace has ${this.changedFiles.length} changed file(s) and ${this.unpushedCommits} unpushed commit(s). Commit and push them, or archive with force to stash the changes and keep the branch.${ignored}`;
	}
}

export class WorkspaceArchivedError extends Schema.TaggedError<WorkspaceArchivedError>()("WorkspaceArchivedError", {
	workspaceId: Schema.String,
}) {
	override get message() {
		return "This workspace is archived. Start a new workspace to keep working.";
	}
}

// Branch names reach git as arguments, so one starting with "-" would read as an option.
export const BranchName = Schema.String.check(Schema.isPattern(/^[^-\s]\S{0,254}$/));

// An open pull request or issue of the project's GitHub repository, to start a workspace from.
export class OpenPullRequest extends Schema.Class<OpenPullRequest>("OpenPullRequest")({
	number: Schema.Int,
	title: Schema.String,
	branch: Schema.String,
	author: Schema.String,
}) {}

export class OpenIssue extends Schema.Class<OpenIssue>("OpenIssue")({
	number: Schema.Int,
	title: Schema.String,
	body: Schema.String,
	url: Schema.String,
}) {}

export class BranchNotFoundError extends Schema.TaggedError<BranchNotFoundError>()("BranchNotFoundError", {
	branch: Schema.String,
}) {
	override get message() {
		return `The branch ${this.branch} does not exist here or on origin. Fetch it or pick another branch.`;
	}
}

export class BranchCheckedOutError extends Schema.TaggedError<BranchCheckedOutError>()("BranchCheckedOutError", {
	branch: Schema.String,
}) {
	override get message() {
		return `The branch ${this.branch} is checked out in another folder. Switch that folder to another branch or archive its workspace first.`;
	}
}

export class PullRequestCheckoutError extends Schema.TaggedError<PullRequestCheckoutError>()(
	"PullRequestCheckoutError",
	{ number: Schema.Int },
) {
	override get message() {
		return `Octopus could not check out pull request #${this.number}. Check that it exists and that its branch is not checked out elsewhere.`;
	}
}

export class GitHubListError extends Schema.TaggedError<GitHubListError>()("GitHubListError", {
	subject: Schema.Literals(["pull requests", "issues"]),
}) {
	override get message() {
		return `Octopus could not list the open ${this.subject}. Check that the project has a GitHub remote.`;
	}
}
