import { orInternalError, orInternalErrorStream } from "./orInternalError.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { WorkspaceRpcs } from "@repo/contracts/WorkspaceRpcs";
import { Effect } from "effect";

export const WorkspaceRpcHandlers = WorkspaceRpcs.toLayer(
	Effect.gen(function* () {
		const workspaces = yield* WorkspaceService;
		return WorkspaceRpcs.of({
			createWorkspace: (input) => workspaces.create(input).pipe(orInternalError("create the workspace")),
			listBranches: ({ projectId }) => workspaces.listProjectBranches(projectId).pipe(orInternalError("list branches")),
			listOpenPullRequests: ({ projectId }) =>
				workspaces.listProjectPullRequests(projectId).pipe(orInternalError("list pull requests")),
			listOpenIssues: ({ projectId }) => workspaces.listProjectIssues(projectId).pipe(orInternalError("list issues")),
			listWorkspaces: ({ projectId }) => workspaces.list(projectId).pipe(orInternalError("list workspaces")),
			archiveWorkspace: ({ workspaceId, force }) =>
				workspaces.archive(workspaceId, { force }).pipe(orInternalError("archive the workspace")),
			unarchiveWorkspace: ({ workspaceId }) =>
				workspaces.unarchive(workspaceId).pipe(orInternalError("restore the workspace")),
			listScriptRuns: ({ workspaceId }) =>
				workspaces.listScriptRuns(workspaceId).pipe(orInternalError("list script runs")),
			getScriptRunOutput: ({ scriptRunId }) => Effect.succeed(workspaces.getScriptRunOutput(scriptRunId)),
			startRunScript: ({ workspaceId }) =>
				workspaces.startRunScript(workspaceId).pipe(orInternalError("start the run script")),
			stopRunScript: ({ workspaceId }) =>
				workspaces.stopRunScript(workspaceId).pipe(orInternalError("stop the run script")),
			watchScriptRuns: ({ workspaceId }) => workspaces.watchScriptRuns(workspaceId),
			watchRunScriptPorts: ({ workspaceId }) =>
				workspaces.watchRunScriptPorts(workspaceId).pipe(orInternalErrorStream("list the run script's ports")),
			followScriptRunOutput: ({ scriptRunId }) => workspaces.followScriptRunOutput(scriptRunId),
		});
	}),
);
