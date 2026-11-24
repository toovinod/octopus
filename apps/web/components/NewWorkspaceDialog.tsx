"use client";

import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@repo/ui/components/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@repo/ui/components/dialog";
import { createWorkspace, newChat, openDialog, sendMessage, useAppState } from "../lib/store.ts";
import type { CreateWorkspaceInput } from "@repo/contracts/WorkspaceRpcs";
import { issueBranchName, issueMessage } from "../lib/issueWorkspace.ts";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { callDaemon, errorMessage } from "../lib/daemonRuntime.ts";
import { type Loaded, useDaemonValue } from "../lib/useDaemonValue.ts";
import type { OpenIssue } from "@repo/contracts/Workspace";
import type { Project } from "@repo/contracts/Project";
import { Textarea } from "@repo/ui/components/textarea";
import { Switch } from "@repo/ui/components/switch";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { isWorkspaceName } from "../lib/names.ts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

export const NewWorkspaceDialog = () => {
	const dialog = useAppState((current) => current.dialog);
	const projectId = dialog?.kind === "newWorkspace" ? dialog.projectId : null;
	const project = useAppState((current) => (projectId === null ? undefined : current.projects[projectId]));
	return (
		<Dialog open={project !== undefined} onOpenChange={(next) => !next && openDialog(null)}>
			{project === undefined ? null : (
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>New workspace in {project.name}</DialogTitle>
						<DialogDescription>
							Each worktree gets its own folder and branch, so agents never step on each other.
						</DialogDescription>
					</DialogHeader>
					<WorkspaceForm project={project} />
				</DialogContent>
			)}
		</Dialog>
	);
};

const SOURCES = [
	{ value: "worktree", title: "New branch", detail: "A new branch and folder, off the base branch you pick." },
	{ value: "branch", title: "Branch", detail: "Check out a branch that already exists, here or on origin." },
	{ value: "pullRequest", title: "Pull request", detail: "Check out a pull request's branch with the GitHub CLI." },
	{ value: "issue", title: "Issue", detail: "A new branch for a GitHub issue, with the issue as the first message." },
	{ value: "inPlace", title: "Project folder", detail: "Work on the checked-out branch in the project folder." },
] as const;

type Source = (typeof SOURCES)[number]["value"];

interface PickItem {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
}

const WorkspaceForm = ({ project }: { readonly project: Project }) => {
	const projectId = project.id;
	const [source, setSource] = useState<Source>("worktree");
	const [name, setName] = useState("");
	const [baseBranch, setBaseBranch] = useState(project.defaultBranch);
	const [branch, setBranch] = useState<string | null>(null);
	const [pullRequest, setPullRequest] = useState<number | null>(null);
	const [issue, setIssue] = useState<OpenIssue | null>(null);
	const [message, setMessage] = useState("");
	const [sendFirst, setSendFirst] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const input = ((): CreateWorkspaceInput | null => {
		switch (source) {
			case "worktree":
			case "issue":
				return isWorkspaceName(name) ? { kind: "worktree", projectId, name, baseBranch } : null;
			case "branch":
				return branch === null ? null : { kind: "branch", projectId, branch };
			case "pullRequest":
				return pullRequest === null ? null : { kind: "pullRequest", projectId, number: pullRequest };
			case "inPlace":
				return { kind: "inPlace", projectId };
		}
	})();
	const firstMessage = source === "issue" && sendFirst ? message.trim() : "";

	const pickIssue = (picked: OpenIssue) => {
		setIssue(picked);
		setName(issueBranchName(picked));
		setMessage(issueMessage(picked));
	};

	return (
		<form
			className="flex min-w-0 flex-col gap-3"
			onSubmit={async (event) => {
				event.preventDefault();
				if (input === null) return;
				setBusy(true);
				setError(null);
				await createWorkspace(input).then(
					async (workspace) => {
						openDialog(null);
						const sessionId = await newChat(workspace.id);
						// Queued by the daemon until the agent is ready, so it can go at once.
						if (sessionId !== null && firstMessage !== "") await sendMessage(sessionId, firstMessage, [], false);
					},
					(failure: unknown) => setError(errorMessage(failure)),
				);
				setBusy(false);
			}}
		>
			<Tabs
				value={source}
				onValueChange={(value) => {
					const picked = SOURCES.find((item) => item.value === value);
					if (picked !== undefined) setSource(picked.value);
					setError(null);
				}}
			>
				<TabsList aria-label="Start from" className="w-full">
					{SOURCES.map((item) => (
						<TabsTrigger key={item.value} value={item.value} className="text-xs">
							{item.title}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<p className="text-xs text-muted-foreground">{SOURCES.find((item) => item.value === source)?.detail}</p>
			{source === "issue" ? <IssuePicker projectId={projectId} selected={issue} onPick={pickIssue} /> : null}
			{source === "worktree" || (source === "issue" && issue !== null) ? (
				<>
					<div className="flex flex-col gap-2">
						<Label htmlFor="workspace-name">Name and branch</Label>
						<Input
							id="workspace-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="fix-login"
							className="font-mono"
						/>
						{name !== "" && !isWorkspaceName(name) ? (
							<p className="text-xs text-attention">Use letters, digits, dots, dashes and underscores.</p>
						) : null}
					</div>
					<BaseBranchPicker projectId={projectId} value={baseBranch} onChange={setBaseBranch} />
				</>
			) : null}
			{source === "branch" ? <BranchPicker projectId={projectId} selected={branch} onPick={setBranch} /> : null}
			{source === "pullRequest" ? (
				<PullRequestPicker projectId={projectId} selected={pullRequest} onPick={setPullRequest} />
			) : null}
			{source === "issue" && issue !== null ? (
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<Switch id="send-issue" checked={sendFirst} onCheckedChange={setSendFirst} />
						<Label htmlFor="send-issue" className="text-xs font-normal">
							Send this to the agent as the first message
						</Label>
					</div>
					<Textarea
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						aria-label="First message"
						rows={5}
						disabled={!sendFirst}
						className="max-h-48 font-sans text-sm"
					/>
				</div>
			) : null}
			{error === null ? null : <p className="text-xs text-destructive">{error}</p>}
			<Button type="submit" variant="default" className="self-end" disabled={busy || input === null}>
				{busy ? "Creating" : "Create workspace"}
			</Button>
		</form>
	);
};

// A searchable list for picking what the workspace starts from.
const PickList = ({
	loaded,
	selected,
	onPick,
	placeholder,
	empty,
}: {
	readonly loaded: Loaded<ReadonlyArray<PickItem>>;
	readonly selected: string | null;
	readonly onPick: (id: string) => void;
	readonly placeholder: string;
	readonly empty: string;
}) =>
	loaded.state === "loading" ? (
		<p className="text-xs text-muted-foreground">Loading</p>
	) : loaded.state === "failed" ? (
		<p className="text-xs text-destructive">{loaded.message}</p>
	) : (
		<Command className="rounded-md border">
			<CommandInput placeholder={placeholder} />
			<CommandList className="max-h-48">
				<CommandEmpty>{empty}</CommandEmpty>
				{loaded.value.map((item) => (
					<CommandItem
						key={item.id}
						value={item.id}
						keywords={[item.label, item.detail ?? ""]}
						onSelect={() => onPick(item.id)}
					>
						<CheckIcon className={item.id === selected ? "" : "invisible"} />
						<span className="truncate">{item.label}</span>
						{item.detail === undefined ? null : (
							<span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{item.detail}</span>
						)}
					</CommandItem>
				))}
			</CommandList>
		</Command>
	);

const mapLoaded = <A, B>(loaded: Loaded<A>, f: (value: A) => B): Loaded<B> =>
	loaded.state === "ready" ? { state: "ready", value: f(loaded.value) } : loaded;

const useBranches = (projectId: string) =>
	useDaemonValue(() => callDaemon((daemon) => daemon.listBranches({ projectId })), projectId).loaded;

const toBranchItems = (branches: ReadonlyArray<string>) => branches.map((name) => ({ id: name, label: name }));

const BranchPicker = ({
	projectId,
	selected,
	onPick,
}: {
	readonly projectId: string;
	readonly selected: string | null;
	readonly onPick: (branch: string) => void;
}) => (
	<PickList
		loaded={mapLoaded(useBranches(projectId), toBranchItems)}
		selected={selected}
		onPick={onPick}
		placeholder="Search branches"
		empty="No branch matches."
	/>
);

const BaseBranchPicker = ({
	projectId,
	value,
	onChange,
}: {
	readonly projectId: string;
	readonly value: string;
	readonly onChange: (branch: string) => void;
}) => {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 text-xs">
				<span className="text-muted-foreground">Base branch</span>
				<span className="font-mono">{value}</span>
				<Button type="button" variant="ghost" size="xs" onClick={() => setOpen((current) => !current)}>
					{open ? "Done" : "Change"}
				</Button>
			</div>
			{open ? (
				<BranchPicker
					projectId={projectId}
					selected={value}
					onPick={(branch) => {
						onChange(branch);
						setOpen(false);
					}}
				/>
			) : null}
		</div>
	);
};

const PullRequestPicker = ({
	projectId,
	selected,
	onPick,
}: {
	readonly projectId: string;
	readonly selected: number | null;
	readonly onPick: (number: number) => void;
}) => {
	const { loaded } = useDaemonValue(
		() => callDaemon((daemon) => daemon.listOpenPullRequests({ projectId })),
		`${projectId}:pullRequests`,
	);
	return (
		<PickList
			loaded={mapLoaded(loaded, (items) =>
				items.map((item) => ({
					id: String(item.number),
					label: `#${item.number} ${item.title}`,
					detail: `${item.branch} by ${item.author}`,
				})),
			)}
			selected={selected === null ? null : String(selected)}
			onPick={(id) => onPick(Number(id))}
			placeholder="Search open pull requests"
			empty="No open pull request matches."
		/>
	);
};

const IssuePicker = ({
	projectId,
	selected,
	onPick,
}: {
	readonly projectId: string;
	readonly selected: OpenIssue | null;
	readonly onPick: (issue: OpenIssue) => void;
}) => {
	const { loaded } = useDaemonValue(
		() => callDaemon((daemon) => daemon.listOpenIssues({ projectId })),
		`${projectId}:issues`,
	);
	const issues = loaded.state === "ready" ? loaded.value : [];
	return (
		<PickList
			loaded={mapLoaded(loaded, (items) =>
				items.map((item) => ({ id: String(item.number), label: `#${item.number} ${item.title}` })),
			)}
			selected={selected === null ? null : String(selected.number)}
			onPick={(id) => {
				const picked = issues.find((item) => String(item.number) === id);
				if (picked !== undefined) onPick(picked);
			}}
			placeholder="Search open issues"
			empty="No open issue matches."
		/>
	);
};
