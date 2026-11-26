import {
	BranchAlreadyExistsError,
	BranchCheckedOutError,
	BranchName,
	BranchNotFoundError,
	GitHubListError,
	OpenIssue,
	OpenPullRequest,
	PullRequestCheckoutError,
	Workspace,
	WorkspaceActivity,
	WorkspaceArchivedError,
	WorkspaceHasUnsavedWorkError,
	WorkspaceName,
	WorkspaceNotFoundError,
	WorkspacePathInUseError,
	WorktreeCreateError,
	WorktreeRemoveError,
} from "./Workspace.ts";
import { RunScriptMissingError, ScriptRun, ScriptRunOutput, SetupScriptMissingError } from "./ScriptRun.ts";
import { GhNotAuthenticatedError, GhNotInstalledError, GitTimeoutError } from "./Git.ts";
import { DaemonInternalError } from "./DaemonInternalError.ts";
import { ProjectNotFoundError } from "./Project.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import { Schema } from "effect";

export const CreateWorkspaceInput = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("worktree"),
		projectId: Schema.String,
		name: WorkspaceName,
		// The project's default branch when left out.
		baseBranch: Schema.optionalKey(BranchName),
	}),
	// A worktree on a branch that already exists, locally or on origin.
	Schema.Struct({
		kind: Schema.Literal("branch"),
		projectId: Schema.String,
		branch: BranchName,
	}),
	// A worktree on the head of a GitHub pull request, checked out with gh.
	Schema.Struct({
		kind: Schema.Literal("pullRequest"),
		projectId: Schema.String,
		number: Schema.Int.check(Schema.isGreaterThan(0)),
	}),
	Schema.Struct({
		kind: Schema.Literal("inPlace"),
		projectId: Schema.String,
	}),
]);
export type CreateWorkspaceInput = typeof CreateWorkspaceInput.Type;

export class WorkspaceRpcs extends RpcGroup.make(
	Rpc.make("createWorkspace", {
		payload: CreateWorkspaceInput,
		success: Workspace,
		error: Schema.Union([
			ProjectNotFoundError,
			WorkspacePathInUseError,
			BranchAlreadyExistsError,
			BranchNotFoundError,
			BranchCheckedOutError,
			WorktreeCreateError,
			PullRequestCheckoutError,
			GhNotInstalledError,
			GhNotAuthenticatedError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	// Local branches and origin's, by name, to start a workspace on or from.
	Rpc.make("listBranches", {
		payload: { projectId: Schema.String },
		success: Schema.Array(Schema.String),
		error: Schema.Union([ProjectNotFoundError, GitTimeoutError, DaemonInternalError]),
	}),
	Rpc.make("listOpenPullRequests", {
		payload: { projectId: Schema.String },
		success: Schema.Array(OpenPullRequest),
		error: Schema.Union([
			ProjectNotFoundError,
			GitHubListError,
			GhNotInstalledError,
			GhNotAuthenticatedError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("listOpenIssues", {
		payload: { projectId: Schema.String },
		success: Schema.Array(OpenIssue),
		error: Schema.Union([
			ProjectNotFoundError,
			GitHubListError,
			GhNotInstalledError,
			GhNotAuthenticatedError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("listWorkspaces", {
		payload: { projectId: Schema.String },
		success: Schema.Array(Workspace),
		error: DaemonInternalError,
	}),
	Rpc.make("archiveWorkspace", {
		payload: { workspaceId: Schema.String, force: Schema.Boolean },
		success: Workspace,
		error: Schema.Union([
			WorkspaceNotFoundError,
			WorkspaceHasUnsavedWorkError,
			WorktreeRemoveError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	// Brings an archived workspace back: its folder from the kept branch, and any changes the archive stashed.
	Rpc.make("unarchiveWorkspace", {
		payload: { workspaceId: Schema.String },
		success: Workspace,
		error: Schema.Union([
			WorkspaceNotFoundError,
			WorkspacePathInUseError,
			BranchNotFoundError,
			BranchCheckedOutError,
			WorktreeCreateError,
			GitTimeoutError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("listScriptRuns", {
		payload: { workspaceId: Schema.String },
		success: Schema.Array(ScriptRun),
		error: DaemonInternalError,
	}),
	// Terminals running a command and scripts still going, so quitting can ask first. Read-only and
	// costs a process listing per terminal, so call it only while a quit is being considered or rarely.
	Rpc.make("listActivity", {
		success: WorkspaceActivity,
		error: DaemonInternalError,
	}),
	Rpc.make("getScriptRunOutput", {
		payload: { scriptRunId: Schema.String },
		success: ScriptRunOutput,
	}),
	// Starts the project's run script in the workspace, or returns the run already going.
	Rpc.make("startRunScript", {
		payload: { workspaceId: Schema.String },
		success: ScriptRun,
		error: Schema.Union([
			WorkspaceNotFoundError,
			WorkspaceArchivedError,
			RunScriptMissingError,
			ProjectNotFoundError,
			DaemonInternalError,
		]),
	}),
	// Starts the project's setup script in the workspace, or returns the run already going. A failed run starts
	// over. A fork's pull request never runs it on its own, so the user starts it here once they have read the code.
	Rpc.make("startSetupScript", {
		payload: { workspaceId: Schema.String },
		success: ScriptRun,
		error: Schema.Union([
			WorkspaceNotFoundError,
			WorkspaceArchivedError,
			SetupScriptMissingError,
			ProjectNotFoundError,
			DaemonInternalError,
		]),
	}),
	Rpc.make("stopRunScript", {
		payload: { workspaceId: Schema.String },
		error: DaemonInternalError,
	}),
	// Each script run of the workspace as its status changes, from the moment of the call.
	Rpc.make("watchScriptRuns", {
		payload: { workspaceId: Schema.String },
		success: ScriptRun,
		stream: true,
	}),
	// The TCP ports the running run script's processes listen on, now and each time they change.
	Rpc.make("watchRunScriptPorts", {
		payload: { workspaceId: Schema.String },
		success: Schema.Array(Schema.Int),
		error: DaemonInternalError,
		stream: true,
	}),
	// The kept output first, then new lines as the script prints them. Ends when the run ends.
	Rpc.make("followScriptRunOutput", {
		payload: { scriptRunId: Schema.String },
		success: Schema.String,
		stream: true,
	}),
) {}
