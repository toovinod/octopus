"use client";

import {
	BrainIcon,
	CheckIcon,
	ChevronRightIcon,
	FileDiffIcon,
	LoaderIcon,
	PlugIcon,
	TerminalIcon,
	TriangleAlertIcon,
	Undo2Icon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import type {
	AgentQuestion,
	ApprovalDecision,
	ApprovalOutcome,
	PlanAnswer,
	PlanOutcome,
	QuestionAnswers,
	ToolCall,
} from "@repo/contracts/AgentEvent";
import { answerQuestion, openDialog, respondToApproval, respondToPlan } from "../lib/store.ts";
import type { AgentMode } from "@repo/contracts/AgentSession";
import { Textarea } from "@repo/ui/components/textarea";
import { Input } from "@repo/ui/components/input";
import { modeLabels } from "../lib/agentModes.ts";
import type { ChatItem } from "../lib/chatReducer.ts";
import { callDaemon } from "../lib/daemonRuntime.ts";
import { memo, useEffect, useRef, useState } from "react";
import { ExternalLink } from "./ExternalLink.tsx";
import { Predicate } from "effect";
import { Button } from "@repo/ui/components/button";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@repo/ui/lib/utils";

const DECISION_LABELS: Record<ApprovalDecision, string> = {
	allowOnce: "Allow",
	allowForSession: "Allow for this chat",
	deny: "Deny",
};

const OUTCOME_LABELS: Record<ApprovalOutcome, string> = {
	allowOnce: "Allowed",
	allowForSession: "Allowed for this chat",
	deny: "Denied",
	cancelled: "Cancelled",
};

// One entry of the chat timeline. Memoized: during streaming only the growing message re-renders.
export const ChatItemView = memo(({ item, sessionId }: { readonly item: ChatItem; readonly sessionId: string }) => {
	switch (item.kind) {
		case "user":
			return (
				<div className="group flex flex-col items-end gap-1.5">
					{item.attachments.length === 0 ? null : (
						<div className="flex flex-wrap justify-end gap-1.5">
							{item.attachments.map((attachment) => (
								<Attachment key={attachment.id} sessionId={sessionId} attachmentId={attachment.id} />
							))}
						</div>
					)}
					{item.text === "" ? null : (
						<div className="max-w-[85%] rounded-xl bg-muted px-3 py-2 whitespace-pre-wrap">{item.text}</div>
					)}
					<Button
						variant="ghost"
						size="xs"
						className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
						onClick={() => openDialog({ kind: "revert", sessionId, messageId: item.messageId })}
					>
						<Undo2Icon />
						Revert to here
					</Button>
				</div>
			);
		case "assistant":
			return <AssistantMessage text={item.text} streaming={item.streaming} />;
		case "reasoning":
			return <ThinkingBlock rowKey={`${sessionId}:${item.key}`} text={item.text} streaming={item.streaming} />;
		case "tool":
			return <ToolCard rowKey={`${sessionId}:${item.key}`} item={item} />;
		case "approval":
			return <ApprovalCard item={item} sessionId={sessionId} />;
		case "plan":
			return <PlanCard item={item} sessionId={sessionId} />;
		case "question":
			return <QuestionCard item={item} sessionId={sessionId} />;
		case "notice":
			return (
				<div
					className={cn(
						"flex items-center gap-2 text-xs",
						item.tone === "error" ? "text-destructive" : "text-attention",
					)}
				>
					<TriangleAlertIcon className="size-3.5 shrink-0" />
					<span>{item.text}</span>
				</div>
			);
	}
});

// Fenced code arrives as <pre><code class="language-x">, with the text as the code element's children.
const fencedCode = (node: ExtraProps["node"]) => {
	const code = node?.children[0];
	if (code?.type !== "element" || code.tagName !== "code") return null;
	const className = code.properties.className;
	const language = Array.isArray(className)
		? (className.find((name) => Predicate.isString(name) && name.startsWith("language-")) ?? "")
		: "";
	const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
	return { language: String(language).slice("language-".length), text: text.replace(/\n$/, "") };
};

const markdownComponents: Components = {
	a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
	pre: ({ node, children }) => {
		const code = fencedCode(node);
		return code === null ? <pre>{children}</pre> : <CodeBlock code={code.text} language={code.language} />;
	},
	// A remote image would load as soon as it renders, so a prompt-injected agent could leak data through its URL.
	img: ({ src, alt }) => (Predicate.isString(src) ? <ExternalLink href={src}>{alt || src}</ExternalLink> : null),
};

const remarkPlugins = [remarkGfm];

// Shows the plain code at once, then the highlighted version when Shiki has loaded and finished.
const CodeBlock = ({ code, language }: { readonly code: string; readonly language: string }) => {
	const [html, setHtml] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		import("../lib/highlightCode.ts")
			.then(({ highlightCode }) => highlightCode(code, language))
			.then(
				(highlighted) => {
					if (live) setHtml(highlighted);
				},
				// Plain code is the fallback, and it is already on screen.
				() => undefined,
			);
		return () => {
			live = false;
		};
	}, [code, language]);
	return html === null ? (
		<pre>
			<code>{code}</code>
		</pre>
	) : (
		// Shiki escapes the code it renders, so its HTML holds no markup from the agent.
		// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output, see above.
		<div dangerouslySetInnerHTML={{ __html: html }} />
	);
};

const MarkdownText = memo(({ text }: { readonly text: string }) => (
	<Markdown components={markdownComponents} remarkPlugins={remarkPlugins}>
		{text}
	</Markdown>
));

const PROSE =
	"prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-headings:my-2 prose-headings:text-sm prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-a:text-running prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:my-2 prose-pre:border prose-pre:bg-sidebar prose-pre:text-foreground prose-table:my-2 prose-th:px-2 prose-td:px-2 [&_.contains-task-list]:list-none [&_.contains-task-list]:pl-1 [&_pre]:[tab-size:2] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_.shiki_span]:text-(--shiki-light) dark:[&_.shiki_span]:text-(--shiki-dark) [overflow-wrap:anywhere]";

// How often a streaming message is parsed again. Parsing the whole message on every frame is the slowest part
// of streaming a long reply.
const STREAMING_RENDER_MS = 150;

const useThrottledText = (text: string) => {
	const [shown, setShown] = useState(text);
	const latest = useRef(text);
	useEffect(() => {
		latest.current = text;
	});
	// Keyed on what is shown rather than on the text, so new deltas do not keep pushing the timer back.
	const behind = shown === text ? null : shown;
	useEffect(() => {
		if (behind === null) return;
		const timer = setTimeout(() => setShown(latest.current), STREAMING_RENDER_MS);
		return () => clearTimeout(timer);
	}, [behind]);
	return shown;
};

const AssistantMessage = ({ text, streaming }: { readonly text: string; readonly streaming: boolean }) => {
	const throttled = useThrottledText(text);
	return (
		<div className={cn(PROSE, "text-foreground")}>
			<MarkdownText text={streaming ? throttled : text} />
		</div>
	);
};

// Rows unmount when they scroll out of view, so a row the user opened or closed keeps that choice here. Until then it
// follows its default, which can change, as when a running tool fails. Only toggled rows are kept, so it stays small.
const toggledRows = new Map<string, boolean>();

const useRowOpen = (rowKey: string, byDefault: boolean) => {
	const [toggled, setToggled] = useState(() => toggledRows.get(rowKey));
	const open = toggled ?? byDefault;
	const toggle = () => {
		toggledRows.set(rowKey, !open);
		setToggled(!open);
	};
	return [open, toggle] as const;
};

// Collapsed by default: the thinking is there for whoever wants it, and the reply stays the focus.
const ThinkingBlock = ({
	rowKey,
	text,
	streaming,
}: {
	readonly rowKey: string;
	readonly text: string;
	readonly streaming: boolean;
}) => {
	const [open, toggle] = useRowOpen(rowKey, false);
	const throttled = useThrottledText(text);
	return (
		<div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
			<button
				type="button"
				onClick={toggle}
				className="flex items-center gap-1.5 self-start hover:text-foreground"
				aria-expanded={open}
			>
				<BrainIcon className="size-3.5 shrink-0" />
				<span className={cn(streaming && "animate-pulse")}>Thinking</span>
				<ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
			</button>
			{open ? (
				<div className={cn(PROSE, "border-l-2 border-border pl-3 text-xs text-muted-foreground")}>
					<MarkdownText text={streaming ? throttled : text} />
				</div>
			) : null}
		</div>
	);
};

// Rows unmount when they scroll out of view, so without this every scroll back downloads the image again.
// Bounded because each image can be megabytes of base64.
const ATTACHMENT_CACHE_SIZE = 20;
const attachmentCache = new Map<string, string>();

const cachedAttachment = (attachmentId: string) => {
	const src = attachmentCache.get(attachmentId);
	if (src !== undefined) {
		// Re-inserting marks it as recently used, so the oldest entry is the first in the map.
		attachmentCache.delete(attachmentId);
		attachmentCache.set(attachmentId, src);
	}
	return src ?? null;
};

const cacheAttachment = (attachmentId: string, src: string) => {
	attachmentCache.set(attachmentId, src);
	const oldest = attachmentCache.keys().next().value;
	if (attachmentCache.size > ATTACHMENT_CACHE_SIZE && oldest !== undefined) attachmentCache.delete(oldest);
};

const Attachment = ({ sessionId, attachmentId }: { readonly sessionId: string; readonly attachmentId: string }) => {
	const [src, setSrc] = useState(() => cachedAttachment(attachmentId));
	useEffect(() => {
		if (attachmentCache.has(attachmentId)) return;
		let live = true;
		callDaemon((daemon) => daemon.getAttachment({ sessionId, attachmentId })).then(
			(image) => {
				const url = `data:${image.mediaType};base64,${image.base64}`;
				cacheAttachment(attachmentId, url);
				if (live) setSrc(url);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [sessionId, attachmentId]);
	return src === null ? (
		<div className="size-16 rounded-lg bg-muted" />
	) : (
		// biome-ignore lint/performance/noImgElement: a data URL in a static export, which next/image cannot optimize.
		<img src={src} alt="" className="size-16 rounded-lg object-cover" />
	);
};

const toolTitle = (tool: ToolCall) => {
	switch (tool.kind) {
		case "command":
			return tool.command;
		case "fileChange":
			return tool.changes.map((change) => change.path).join(", ");
		case "mcpCall":
			return `${tool.server}.${tool.tool}`;
		case "other":
			return tool.name;
	}
};

const TOOL_ICONS = {
	command: TerminalIcon,
	fileChange: FileDiffIcon,
	mcpCall: PlugIcon,
	other: WrenchIcon,
} as const;

const ToolCard = ({
	rowKey,
	item,
}: {
	readonly rowKey: string;
	readonly item: Extract<ChatItem, { kind: "tool" }>;
}) => {
	const [open, toggle] = useRowOpen(rowKey, item.status === "failed");
	const Icon = TOOL_ICONS[item.tool.kind];
	const detail =
		item.tool.kind === "fileChange" ? item.tool.changes.map((change) => change.diff).join("\n") : item.output;
	return (
		<div className="rounded-lg border border-border bg-card">
			<button
				type="button"
				onClick={toggle}
				disabled={detail === null || detail === ""}
				className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
				aria-expanded={open}
			>
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate font-mono">{toolTitle(item.tool)}</span>
				{item.status === "running" ? (
					<LoaderIcon className="size-3.5 shrink-0 animate-spin text-running" />
				) : item.status === "completed" ? (
					<CheckIcon className="size-3.5 shrink-0 text-success" />
				) : (
					<span className="flex shrink-0 items-center gap-1 text-destructive">
						<XIcon className="size-3.5" />
						{item.status === "declined" ? "Declined" : "Failed"}
					</span>
				)}
				{detail === null || detail === "" ? null : (
					<ChevronRightIcon
						className={cn("size-3 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-90")}
					/>
				)}
			</button>
			{open && detail !== null ? (
				<pre className="max-h-64 overflow-auto border-t border-border px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
					{detail}
				</pre>
			) : null}
		</div>
	);
};

// The same choices Claude Code and Codex offer after a plan, one per mode the plan may be built in.
const BUILD_LABELS: Partial<Record<AgentMode, string>> = {
	auto: "Yes, and use auto mode",
	acceptEdits: "Yes, auto-accept edits",
	ask: "Yes, and ask before each change",
	fullAccess: "Yes, with full access (no prompts)",
};

const planOutcomeText = (outcome: PlanOutcome) => {
	switch (outcome.type) {
		case "approve":
			return `Approved · ${modeLabels[outcome.mode].label}`;
		case "revise":
			return "Kept planning";
		case "cancelled":
			return "Not answered";
	}
};

const PlanCard = ({
	item,
	sessionId,
}: {
	readonly item: Extract<ChatItem, { kind: "plan" }>;
	readonly sessionId: string;
}) => {
	const [sending, setSending] = useState(false);
	const [feedback, setFeedback] = useState("");
	const answer = async (planAnswer: PlanAnswer) => {
		setSending(true);
		await respondToPlan(sessionId, item.requestId, planAnswer);
		setSending(false);
	};
	const waiting = item.outcome === null;
	return (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-lg border px-3 py-2.5",
				waiting ? "border-attention/50 bg-attention/5" : "border-border bg-card",
			)}
		>
			<div className="flex items-center gap-2 text-xs">
				<span className={waiting ? "font-medium text-attention" : "text-muted-foreground"}>
					{item.outcome === null ? "Plan ready" : planOutcomeText(item.outcome)}
				</span>
			</div>
			{item.text === "" ? (
				<p className="text-sm text-muted-foreground">The agent finished planning without writing a plan.</p>
			) : (
				<AssistantMessage text={item.text} streaming={false} />
			)}
			{item.outcome?.type === "revise" && item.outcome.feedback !== "" ? (
				<p className="border-l-2 pl-2 text-xs text-muted-foreground whitespace-pre-wrap">{item.outcome.feedback}</p>
			) : null}
			{waiting ? (
				<>
					<div className="flex flex-wrap gap-1.5">
						{item.choices.map((mode, index) => (
							<Button
								key={mode}
								size="sm"
								variant={mode === "fullAccess" ? "destructive" : index === 0 ? "default" : "secondary"}
								disabled={sending}
								onClick={() => void answer({ type: "approve", mode })}
							>
								{BUILD_LABELS[mode] ?? `Yes, in ${modeLabels[mode].label}`}
							</Button>
						))}
					</div>
					<div className="flex items-end gap-1.5">
						<Textarea
							value={feedback}
							onChange={(event) => setFeedback(event.target.value)}
							placeholder="Tell the agent what to change"
							aria-label="Feedback on the plan"
							className="min-h-9 text-sm"
							rows={1}
						/>
						<Button
							size="sm"
							variant="ghost"
							disabled={sending}
							onClick={() => void answer({ type: "revise", feedback: feedback.trim() })}
						>
							No, keep planning
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
};

// The picked options plus any typed answer. A single-choice question takes one or the other.
const questionAnswer = (question: AgentQuestion, picked: ReadonlyArray<string>, typed: string) => {
	const text = typed.trim();
	if (question.multiSelect) return text === "" ? picked : [...picked, text];
	return text === "" ? picked.slice(0, 1) : [text];
};

const QuestionCard = ({
	item,
	sessionId,
}: {
	readonly item: Extract<ChatItem, { kind: "question" }>;
	readonly sessionId: string;
}) => {
	const [sending, setSending] = useState(false);
	const [picked, setPicked] = useState<Record<string, ReadonlyArray<string>>>({});
	const [typed, setTyped] = useState<Record<string, string>>({});
	const answers: QuestionAnswers = Object.fromEntries(
		item.questions.map((question) => [
			question.id,
			questionAnswer(question, picked[question.id] ?? [], typed[question.id] ?? ""),
		]),
	);
	const complete = item.questions.every((question) => (answers[question.id] ?? []).length > 0);
	const pick = (question: AgentQuestion, label: string) => {
		const current = picked[question.id] ?? [];
		const next = question.multiSelect
			? current.includes(label)
				? current.filter((item) => item !== label)
				: [...current, label]
			: [label];
		setPicked({ ...picked, [question.id]: next });
		if (!question.multiSelect) setTyped({ ...typed, [question.id]: "" });
	};
	const submit = async () => {
		setSending(true);
		await answerQuestion(sessionId, item.requestId, answers);
		setSending(false);
	};
	const { outcome } = item;
	const waiting = outcome === null;
	return (
		<div
			className={cn(
				"flex flex-col gap-3 rounded-lg border px-3 py-2.5",
				waiting ? "border-attention/50 bg-attention/5" : "border-border bg-card",
			)}
		>
			<span className={cn("text-xs", waiting ? "font-medium text-attention" : "text-muted-foreground")}>
				{waiting ? "The agent has a question" : outcome.type === "answered" ? "Answered" : "Not answered"}
			</span>
			{item.questions.map((question) => (
				<div key={question.id} className="flex flex-col gap-1.5">
					<span className="text-xs text-muted-foreground">{question.header}</span>
					<p className="text-sm">{question.question}</p>
					{waiting ? (
						<>
							{question.options.length === 0 ? null : (
								<div className="flex flex-wrap gap-1.5">
									{question.options.map((option) => (
										<Button
											key={option.label}
											size="sm"
											variant={(picked[question.id] ?? []).includes(option.label) ? "default" : "secondary"}
											aria-pressed={(picked[question.id] ?? []).includes(option.label)}
											aria-label={option.label}
											title={option.description}
											disabled={sending}
											onClick={() => pick(question, option.label)}
										>
											{option.label}
										</Button>
									))}
								</div>
							)}
							{question.allowsOther ? (
								<Input
									type={question.secret ? "password" : "text"}
									value={typed[question.id] ?? ""}
									onChange={(event) => {
										setTyped({ ...typed, [question.id]: event.target.value });
										if (!question.multiSelect && event.target.value !== "") {
											setPicked({ ...picked, [question.id]: [] });
										}
									}}
									placeholder={question.options.length === 0 ? "Your answer" : "Or type your own answer"}
									aria-label={question.question}
									className="h-8 text-sm"
									disabled={sending}
								/>
							) : null}
						</>
					) : outcome.type === "answered" ? (
						<p className="border-l-2 pl-2 text-xs text-muted-foreground">
							{question.secret ? "Hidden" : (outcome.answers[question.id] ?? []).join(", ")}
						</p>
					) : null}
				</div>
			))}
			{waiting ? (
				<div>
					<Button size="sm" disabled={sending || !complete} onClick={() => void submit()}>
						Answer
					</Button>
				</div>
			) : null}
		</div>
	);
};

const ApprovalCard = ({
	item,
	sessionId,
}: {
	readonly item: Extract<ChatItem, { kind: "approval" }>;
	readonly sessionId: string;
}) => {
	const [sending, setSending] = useState<ApprovalDecision | null>(null);
	const answer = async (decision: ApprovalDecision) => {
		setSending(decision);
		await respondToApproval(sessionId, item.requestId, decision);
		setSending(null);
	};
	return (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-lg border px-3 py-2.5",
				item.outcome === null ? "border-attention/50 bg-attention/5" : "border-border bg-card",
			)}
		>
			<div className="flex items-center gap-2 text-xs">
				<span className={item.outcome === null ? "font-medium text-attention" : "text-muted-foreground"}>
					{item.outcome === null ? "Approval needed" : OUTCOME_LABELS[item.outcome]}
				</span>
			</div>
			<code className="font-mono text-xs break-all">{item.summary}</code>
			{item.reason === null ? null : <p className="text-xs text-muted-foreground">{item.reason}</p>}
			{item.outcome === null ? (
				<div className="flex flex-wrap gap-1.5">
					{item.choices.map((decision) => (
						<Button
							key={decision}
							size="sm"
							variant={decision === "deny" ? "ghost" : decision === "allowOnce" ? "default" : "secondary"}
							disabled={sending !== null}
							onClick={() => void answer(decision)}
						>
							{DECISION_LABELS[decision]}
						</Button>
					))}
				</div>
			) : null}
		</div>
	);
};
