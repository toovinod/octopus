"use client";

import { type DiffRow, diffRows, type Segment, startsOpen } from "../lib/diffRows.ts";
import type { DiffFile, DiffLine, WorkspaceDiff } from "@repo/contracts/Git";
import { ChevronRightIcon, GitCommitIcon, RefreshCwIcon, SendIcon, UploadIcon, XIcon } from "lucide-react";
import {
	codeIn,
	covers,
	type DiffComment,
	type DiffSide,
	diffCommentsMessage,
	type LineRange,
	numberOn,
	pickLines,
	rangeLabel,
	sideOf,
} from "../lib/diffComments.ts";
import { Textarea } from "@repo/ui/components/textarea";
import { callDaemon, errorMessage } from "../lib/daemonRuntime.ts";
import { newChat, sendMessage, toast, updateSettings, useAppState, workingChats } from "../lib/store.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "@repo/contracts/Workspace";
import { useVirtualizer } from "@tanstack/react-virtual";
import { commitPaths } from "../lib/commitPaths.ts";
import { Hint } from "./Hint.tsx";
import { Button } from "@repo/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/components/tabs";
import { Input } from "@repo/ui/components/input";
import { cn } from "@repo/ui/lib/utils";

const DIFF_MODES = ["unified", "split"] as const;

const STATUS_LETTERS = {
	added: { letter: "A", tone: "text-success" },
	untracked: { letter: "U", tone: "text-success" },
	deleted: { letter: "D", tone: "text-destructive" },
	modified: { letter: "M", tone: "text-attention" },
	renamed: { letter: "R", tone: "text-running" },
} as const;

// Agents change files while they work, so the diff reloads every few seconds while a chat here works.
const WORKING_RELOAD_MS = 5000;

// Comments outlive the panel, so switching tabs and back keeps them until they are sent.
const commentsByWorkspace = new Map<string, ReadonlyArray<DiffComment>>();

// Which files the commit takes. Every file starts ticked.
interface FileSelection {
	readonly included: (path: string) => boolean;
	readonly onChange: (path: string, included: boolean) => void;
}

// Says whether a line number is picked or has a comment, and picks it on click.
interface LinePicking {
	readonly onPick: (range: LineRange, extend: boolean) => void;
	readonly marked: (path: string, side: DiffSide, line: number | null) => boolean;
}

export const DiffView = ({ workspace }: { readonly workspace: Workspace }) => {
	const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	// Files the user opened or closed, overriding startsOpen.
	const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
	const mode = useAppState((current) => current.settings.diffMode);
	const working = useAppState((current) => workingChats(Object.values(current.sessions), workspace.id));
	const reverts = useAppState((current) => current.reverts[workspace.id] ?? 0);
	const [comments, setComments] = useState(() => commentsByWorkspace.get(workspace.id) ?? []);
	const [picked, setPicked] = useState<LineRange | null>(null);
	const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
	const selection = useMemo<FileSelection>(
		() => ({
			included: (path) => !excluded.has(path),
			onChange: (path, included) =>
				setExcluded((current) => {
					const next = new Set(current);
					if (included) next.delete(path);
					else next.add(path);
					return next;
				}),
		}),
		[excluded],
	);

	useEffect(() => {
		commentsByWorkspace.set(workspace.id, comments);
	}, [workspace.id, comments]);

	const picking = useMemo<LinePicking>(
		() => ({
			onPick: (range, extend) => setPicked((current) => pickLines(current, range, extend)),
			marked: (path, side, line) =>
				(picked !== null && covers(picked, path, side, line)) ||
				comments.some((comment) => covers(comment, path, side, line)),
		}),
		[picked, comments],
	);

	const addComment = (text: string) => {
		const file = diff?.files.find((item) => item.path === picked?.path);
		if (picked === null || file === undefined) return;
		setComments((current) => [...current, { ...picked, id: crypto.randomUUID(), code: codeIn(file, picked), text }]);
		setPicked(null);
	};

	// Loads can overlap, and an older one can answer last. Only the latest request may show its result.
	const latestLoad = useRef(0);
	const load = useCallback(async () => {
		const request = ++latestLoad.current;
		const isLatest = () => request === latestLoad.current;
		setLoading(true);
		await callDaemon((daemon) => daemon.getWorkspaceDiff({ workspaceId: workspace.id })).then(
			(loaded) => {
				if (!isLatest()) return;
				setDiff(loaded);
				setError(null);
			},
			(failure: unknown) => {
				if (isLatest()) setError(errorMessage(failure));
			},
		);
		if (isLatest()) setLoading(false);
	}, [workspace.id]);

	// A chat starting or stopping work and a revert are when files change. Renames and model changes are not.
	// biome-ignore lint/correctness/useExhaustiveDependencies: working and reverts are the reload signals.
	useEffect(() => {
		void load();
	}, [load, working, reverts]);

	useEffect(() => {
		if (working === "") return;
		const timer = setInterval(() => void load(), WORKING_RELOAD_MS);
		return () => clearInterval(timer);
	}, [load, working]);

	const loadFullFile = async (path: string) => {
		const file = await callDaemon((daemon) => daemon.getFileDiff({ workspaceId: workspace.id, path })).catch(
			(failure: unknown) => {
				toast(errorMessage(failure));
				return null;
			},
		);
		if (file === null) return;
		setDiff((current) =>
			current === null
				? current
				: { ...current, files: current.files.map((item) => (item.path === path ? file : item)) },
		);
	};

	const isOpen = useCallback((file: DiffFile) => toggled.get(file.path) ?? startsOpen(file), [toggled]);
	const rows = useMemo(() => (diff === null ? [] : diffRows(diff.files, mode, isOpen)), [diff, mode, isOpen]);
	const totals = useMemo(
		() =>
			(diff?.files ?? []).reduce(
				(sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
				{ additions: 0, deletions: 0 },
			),
		[diff],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
				<span className="text-muted-foreground">
					{diff === null ? "Loading changes" : `${diff.files.length} files changed against ${diff.baseBranch}`}
				</span>
				{diff === null ? null : (
					<span className="font-mono">
						<span className="text-success">+{totals.additions}</span>{" "}
						<span className="text-destructive">-{totals.deletions}</span>
					</span>
				)}
				<div className="flex-1" />
				<Tabs
					value={mode}
					onValueChange={(value) => {
						const option = DIFF_MODES.find((item) => item === value);
						if (option !== undefined) updateSettings({ diffMode: option });
					}}
				>
					<TabsList aria-label="Diff layout" className="h-6! p-0.5">
						{DIFF_MODES.map((option) => (
							<TabsTrigger key={option} value={option} className="px-1.5 py-0 text-xs capitalize">
								{option}
							</TabsTrigger>
						))}
					</TabsList>
				</Tabs>
				<Hint label="Reload the diff">
					<Button variant="ghost" size="icon-xs" aria-label="Reload the diff" onClick={() => void load()}>
						<RefreshCwIcon className={cn(loading && "animate-spin")} />
					</Button>
				</Hint>
			</div>
			<CommitBar
				workspace={workspace}
				files={diff?.files ?? []}
				excluded={excluded}
				onCommitted={() => {
					setExcluded(new Set());
					void load();
				}}
			/>
			{error !== null ? (
				<p className="p-4 text-xs text-destructive">{error}</p>
			) : diff !== null && diff.files.length === 0 ? (
				<p className="p-4 text-xs text-muted-foreground">No changes against {diff.baseBranch} yet.</p>
			) : (
				<DiffRows
					rows={rows}
					mode={mode}
					picking={picking}
					selection={selection}
					onToggle={(file) => setToggled((current) => new Map(current).set(file.path, !isOpen(file)))}
					onLoadFull={(path) => void loadFullFile(path)}
				/>
			)}
			<CommentTray
				workspace={workspace}
				picked={picked}
				comments={comments}
				onAdd={addComment}
				onCancel={() => setPicked(null)}
				onRemove={(id) => setComments((current) => current.filter((comment) => comment.id !== id))}
				onSent={() => setComments([])}
			/>
		</div>
	);
};

const CommitBar = ({
	workspace,
	files,
	excluded,
	onCommitted,
}: {
	readonly workspace: Workspace;
	readonly files: ReadonlyArray<DiffFile>;
	readonly excluded: ReadonlySet<string>;
	readonly onCommitted: () => void;
}) => {
	const [message, setMessage] = useState("");
	const hasChanges = files.length > 0;
	const ticked = files.filter((file) => !excluded.has(file.path)).length;
	const [busy, setBusy] = useState<"commit" | "push" | null>(null);
	const commit = async () => {
		setBusy("commit");
		await callDaemon((daemon) =>
			daemon.commit({ workspaceId: workspace.id, message, paths: commitPaths(files, excluded) }),
		).then(
			(result) => {
				setMessage("");
				toast(`Committed ${result.sha.slice(0, 7)}`, "info");
				onCommitted();
			},
			(failure: unknown) => toast(errorMessage(failure)),
		);
		setBusy(null);
	};
	const push = async () => {
		setBusy("push");
		await callDaemon((daemon) => daemon.push({ workspaceId: workspace.id })).then(
			() => toast(`Pushed ${workspace.branch}`, "info"),
			(failure: unknown) => toast(errorMessage(failure)),
		);
		setBusy(null);
	};
	return (
		<form
			className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (message.trim() !== "" && ticked > 0) void commit();
			}}
		>
			<Input
				value={message}
				onChange={(event) => setMessage(event.target.value)}
				placeholder={hasChanges ? "Commit message" : "Nothing to commit"}
				disabled={!hasChanges || busy !== null}
				aria-label="Commit message"
				className="h-8"
			/>
			<Button
				variant="secondary"
				type="submit"
				size="sm"
				disabled={!hasChanges || ticked === 0 || message.trim() === "" || busy !== null}
			>
				<GitCommitIcon />
				{ticked === files.length ? "Commit" : `Commit ${ticked} of ${files.length}`}
			</Button>
			<Hint label={`Push ${workspace.branch} to origin`}>
				<Button variant="ghost" size="icon-sm" aria-label="Push" disabled={busy !== null} onClick={() => void push()}>
					<UploadIcon />
				</Button>
			</Hint>
		</form>
	);
};

const CommentTray = ({
	workspace,
	picked,
	comments,
	onAdd,
	onCancel,
	onRemove,
	onSent,
}: {
	readonly workspace: Workspace;
	readonly picked: LineRange | null;
	readonly comments: ReadonlyArray<DiffComment>;
	readonly onAdd: (text: string) => void;
	readonly onCancel: () => void;
	readonly onRemove: (id: string) => void;
	readonly onSent: () => void;
}) => {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const sessionId = useAppState((current) =>
		current.selectedSessionId !== null && current.sessions[current.selectedSessionId]?.workspaceId === workspace.id
			? current.selectedSessionId
			: null,
	);
	if (picked === null && comments.length === 0) return null;

	const add = () => {
		if (text.trim() === "") return;
		onAdd(text);
		setText("");
	};
	const send = async () => {
		setSending(true);
		// With no chat open here, start one so the comments still reach an agent. newChat explains a failure.
		const target = sessionId ?? (await newChat(workspace.id));
		// A refused send waits in that chat's composer with the daemon's reason, so the comments are not lost.
		if (target !== null && (await sendMessage(target, diffCommentsMessage(comments), [], false))) {
			toast("Sent the comments to the agent.", "info");
			onSent();
		}
		setSending(false);
	};

	return (
		<div className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-t border-border bg-card p-3 text-xs">
			{comments.map((comment) => (
				<div key={comment.id} className="flex items-start gap-2">
					<div className="min-w-0 flex-1">
						<p className="truncate font-mono text-muted-foreground">{rangeLabel(comment)}</p>
						<p className="whitespace-pre-wrap">{comment.text}</p>
					</div>
					<Button variant="ghost" size="icon-xs" aria-label="Remove comment" onClick={() => onRemove(comment.id)}>
						<XIcon />
					</Button>
				</div>
			))}
			{picked === null ? null : (
				<form
					className="flex flex-col gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						add();
					}}
				>
					<p className="font-mono text-muted-foreground">
						{rangeLabel(picked)} <span className="font-sans">(shift-click another line for a range)</span>
					</p>
					<Textarea
						autoFocus
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								add();
							}
							if (event.key === "Escape") onCancel();
						}}
						placeholder="Comment for the agent"
						aria-label="Comment for the agent"
						className="min-h-14 text-xs md:text-xs"
					/>
					<div className="flex gap-1.5">
						<Button type="submit" size="xs" disabled={text.trim() === ""}>
							Add comment
						</Button>
						<Button type="button" size="xs" variant="ghost" onClick={onCancel}>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{comments.length === 0 ? null : (
				<Button variant="secondary" size="sm" className="self-start" disabled={sending} onClick={() => void send()}>
					<SendIcon />
					Send {comments.length === 1 ? "1 comment" : `${comments.length} comments`} to the agent
				</Button>
			)}
		</div>
	);
};

const ROW_HEIGHTS: Record<DiffRow["type"], number> = { file: 32, hunk: 24, line: 20, pair: 20, notice: 36 };

const DiffRows = ({
	rows,
	mode,
	picking,
	selection,
	onToggle,
	onLoadFull,
}: {
	readonly rows: ReadonlyArray<DiffRow>;
	readonly mode: "unified" | "split";
	readonly picking?: LinePicking;
	readonly selection?: FileSelection;
	readonly onToggle?: (file: DiffFile) => void;
	readonly onLoadFull?: (path: string) => void;
}) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) => ROW_HEIGHTS[rows[index]?.type ?? "line"],
		getItemKey: (index) => {
			const row = rows[index];
			return row === undefined ? index : row.type === "file" ? `file:${row.file.path}` : row.key;
		},
		overscan: 20,
	});
	return (
		<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
			<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const row = rows[virtualRow.index];
					return row === undefined ? null : (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
							ref={virtualizer.measureElement}
							className="absolute inset-x-0"
							style={{ transform: `translateY(${virtualRow.start}px)` }}
						>
							<RowView
								row={row}
								mode={mode}
								picking={picking}
								selection={selection}
								onToggle={onToggle}
								onLoadFull={onLoadFull}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
};

const RowView = ({
	row,
	mode,
	picking,
	selection,
	onToggle,
	onLoadFull,
}: {
	readonly row: DiffRow;
	readonly mode: "unified" | "split";
	readonly picking: LinePicking | undefined;
	readonly selection: FileSelection | undefined;
	readonly onToggle: ((file: DiffFile) => void) | undefined;
	readonly onLoadFull: ((path: string) => void) | undefined;
}) => {
	switch (row.type) {
		case "file": {
			const status = STATUS_LETTERS[row.file.status];
			return (
				<div className="flex h-8 w-full items-center border-y border-border bg-card font-sans">
					{selection === undefined ? null : (
						<input
							type="checkbox"
							checked={selection.included(row.file.path)}
							onChange={(event) => selection.onChange(row.file.path, event.target.checked)}
							aria-label={`Include ${row.file.path} in the commit`}
							className="ml-3 size-3.5 shrink-0 accent-primary"
						/>
					)}
					<button
						type="button"
						disabled={onToggle === undefined}
						onClick={() => onToggle?.(row.file)}
						aria-expanded={row.open}
						className={cn(
							"flex h-full min-w-0 flex-1 items-center gap-2 pr-3 text-left",
							selection === undefined ? "pl-3" : "pl-2",
						)}
					>
						<ChevronRightIcon
							className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", row.open && "rotate-90")}
						/>
						<span className={cn("w-3 font-mono font-semibold", status.tone)}>{status.letter}</span>
						<span className="min-w-0 flex-1 truncate">
							{row.file.oldPath === null ? row.file.path : `${row.file.oldPath} to ${row.file.path}`}
						</span>
						<span className="font-mono">
							<span className="text-success">+{row.file.additions}</span>{" "}
							<span className="text-destructive">-{row.file.deletions}</span>
						</span>
					</button>
				</div>
			);
		}
		case "hunk":
			return <div className="truncate bg-diff-hunk px-3 py-1 text-running">{row.header}</div>;
		case "notice":
			return (
				<div className="flex items-center gap-2 px-3 py-2 font-sans text-muted-foreground">
					{row.reason === "binary" ? (
						"Binary file, not shown."
					) : (
						<>
							This diff is too large to show at once.
							{onLoadFull === undefined ? null : (
								<Button size="xs" variant="secondary" onClick={() => onLoadFull(row.path)}>
									Load it
								</Button>
							)}
						</>
					)}
				</div>
			);
		case "line": {
			const side = sideOf(row.line);
			const pick = { path: row.path, side, line: numberOn(row.line, side), picking };
			return (
				<div className={cn("flex min-h-5", lineTone(row.line))}>
					<LineNumber value={row.line.oldLine} pick={pick} />
					<LineNumber value={row.line.newLine} pick={pick} />
					<span className="w-4 shrink-0 text-center text-muted-foreground/60 select-none">
						{MARKERS[row.line.kind]}
					</span>
					<LineText line={row.line} segments={row.segments} />
				</div>
			);
		}
		case "pair":
			return mode === "split" ? (
				<div className="grid min-h-5 grid-cols-2">
					<Half
						line={row.left}
						number={row.left?.oldLine ?? null}
						segments={row.leftSegments}
						pick={{ path: row.path, side: "old", line: row.left?.oldLine ?? null, picking }}
					/>
					<Half
						line={row.right}
						number={row.right?.newLine ?? null}
						segments={row.rightSegments}
						pick={{ path: row.path, side: "new", line: row.right?.newLine ?? null, picking }}
					/>
				</div>
			) : null;
	}
};

const MARKERS = { add: "+", delete: "-", context: " " } as const;

const lineTone = (line: DiffLine) =>
	line.kind === "add" ? "bg-diff-add" : line.kind === "delete" ? "bg-diff-delete" : "";

// The line a number stands for when clicked: in unified view both numbers pick the line's own side.
interface PickTarget {
	readonly path: string;
	readonly side: DiffSide;
	readonly line: number | null;
	readonly picking: LinePicking | undefined;
}

const LineNumber = ({ value, pick }: { readonly value: number | null; readonly pick: PickTarget }) => {
	const { path, side, line, picking } = pick;
	const className = "w-10 shrink-0 pr-2 text-right text-muted-foreground/60 select-none";
	if (picking === undefined || line === null || value === null) return <span className={className}>{value ?? ""}</span>;
	return (
		<button
			type="button"
			aria-label={`Comment on line ${line}`}
			onClick={(event) => picking.onPick({ path, side, start: line, end: line }, event.shiftKey)}
			className={cn(
				className,
				"cursor-pointer hover:bg-running/20 hover:text-foreground",
				picking.marked(path, side, line) && "bg-running/30 text-foreground",
			)}
		>
			{value}
		</button>
	);
};

const LineText = ({
	line,
	segments,
}: {
	readonly line: DiffLine;
	readonly segments: ReadonlyArray<Segment> | null;
}) => (
	<span className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">
		{segments === null
			? line.text
			: segments.map((segment, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: segments never reorder.
						key={index}
						className={cn(
							segment.changed &&
								(line.kind === "add" ? "rounded-sm bg-diff-add-word" : "rounded-sm bg-diff-delete-word"),
						)}
					>
						{segment.text}
					</span>
				))}
	</span>
);

const Half = ({
	line,
	number,
	segments,
	pick,
}: {
	readonly line: DiffLine | null;
	readonly number: number | null;
	readonly segments: ReadonlyArray<Segment> | null;
	readonly pick: PickTarget;
}) =>
	line === null ? (
		<div className="bg-muted/40" />
	) : (
		<div className={cn("flex min-w-0 border-r border-border last:border-r-0", lineTone(line))}>
			<LineNumber value={number} pick={pick} />
			<LineText line={line} segments={segments} />
		</div>
	);
