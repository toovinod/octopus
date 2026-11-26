import { orInternalError, orInternalErrorStream } from "./orInternalError.ts";
import { countRunningScripts } from "../workspaces/countRunningScripts.ts";
import { WorkspaceService } from "../workspaces/WorkspaceService.ts";
import { TerminalService } from "../terminals/TerminalService.ts";
import type { LocalDatabase } from "../database/LocalDatabase.ts";
import { WorkspaceActivity } from "@repo/contracts/Workspace";
import { WorkspaceRpcs } from "@repo/contracts/WorkspaceRpcs";
import type { ChildProcessSpawner } from "effect/process";
import { Effect } from "effect";

export const WorkspaceRpcHandlers = WorkspaceRpcs.toLayer(
	Effect.gen(function* () {
		const workspaces = yield* WorkspaceService;
		const terminals = yield* TerminalService;
		const services = yield* Effect.context<LocalDatabase | ChildProcessSpawner.ChildProcessSpawner>();
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
			listActivity: () =>
				Effect.all({ busyTerminals: terminals.countBusy, runningScripts: countRunningScripts() }).pipe(
					Effect.map((activity) => new WorkspaceActivity(activity)),
					Effect.provide(services),
					orInternalError("list what is running"),
				),
			getScriptRunOutput: ({ scriptRunId }) => Effect.succeed(workspaces.getScriptRunOutput(scriptRunId)),
			startRunScript: ({ workspaceId }) =>
				workspaces.startRunScript(workspaceId).pipe(orInternalError("start the run script")),
			startSetupScript: ({ workspaceId }) =>
				workspaces.startSetupScriptRun(workspaceId).pipe(orInternalError("start the setup script")),
			stopRunScript: ({ workspaceId }) =>
				workspaces.stopRunScript(workspaceId).pipe(orInternalError("stop the run script")),
			watchScriptRuns: ({ workspaceId }) => workspaces.watchScriptRuns(workspaceId),
			watchRunScriptPorts: ({ workspaceId }) =>
				workspaces.watchRunScriptPorts(workspaceId).pipe(orInternalErrorStream("list the run script's ports")),
			followScriptRunOutput: ({ scriptRunId }) => workspaces.followScriptRunOutput(scriptRunId),
		});
	}),
);
