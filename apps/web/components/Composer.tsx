"use client";

import { ArrowUpIcon, ChevronDownIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { Textarea } from "@repo/ui/components/textarea";
import {
	discardFailedSend,
	type FailedSend,
	failedSendsOf,
	interruptSession,
	retryFailedSend,
	sendMessage,
	toast,
	updateSessionSettings,
	useAppState,
} from "../lib/store.ts";
import { MAX_IMAGES_PER_MESSAGE, readImages } from "../lib/images.ts";
import { type Draft, draftOf, keepDraft } from "../lib/drafts.ts";
import { memo, useEffect, useId, useRef, useState } from "react";
import type { AgentInfo, AgentSession } from "@repo/contracts/AgentSession";
import type { ChatState } from "../lib/chatReducer.ts";
import { formatClockTime, formatTokens } from "../lib/format.ts";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { modeLabels, nextMode, orderedModes } from "../lib/agentModes.ts";
import { type Suggestion, SuggestionList, suggestionOptionId, useSuggestions } from "./ComposerSuggestions.tsx";
import { insertSuggestion, tokenAt } from "../lib/composerSuggestions.ts";
import { Hint } from "./Hint.tsx";
import { Button } from "@repo/ui/components/button";
import { cn } from "@repo/ui/lib/utils";

// Memoized with only the chat fields it shows, so streamed output does not re-render it.
export const Composer = memo(
	({
		session,
		agent,
		usage,
		rateLimit,
	}: {
		readonly session: AgentSession;
		readonly agent: AgentInfo | undefined;
		readonly usage: ChatState["usage"];
		readonly rateLimit: ChatState["rateLimit"];
	}) => {
		const [draft, setDraft] = useState<Draft>(() => draftOf(session.id));
		const [dragging, setDragging] = useState(false);
		const textRef = useRef<HTMLTextAreaElement>(null);
		const fileRef = useRef<HTMLInputElement>(null);
		const model = agent?.models.find((item) => item.id === session.model);
		const busy = session.status === "running" || session.status === "awaitingApproval";
		const steer = busy && agent?.capabilities.steerWhileRunning === true;
		const failedSends = useAppState((current) => failedSendsOf(current, session.id));
		const [caret, setCaret] = useState(0);
		// Escape hides the suggestions for the word it was pressed in.
		const [dismissedAt, setDismissedAt] = useState<number | null>(null);
		const [highlight, setHighlight] = useState(0);
		const typed = tokenAt(draft.text, caret);
		const token = typed !== null && typed.start !== dismissedAt ? typed : null;
		const suggestions = useSuggestions(session, token);
		const shown = Math.min(highlight, suggestions.length - 1);
		const suggestionsId = useId();

		// biome-ignore lint/correctness/useExhaustiveDependencies: a new word or query starts at the top.
		useEffect(() => {
			setHighlight(0);
		}, [token?.start, token?.query]);

		useEffect(() => {
			keepDraft(session.id, draft);
		}, [session.id, draft]);

		useEffect(() => {
			textRef.current?.focus();
		}, []);

		const addFiles = async (files: ReadonlyArray<File>) => {
			if (files.length === 0) return;
			if (model?.supportsImages !== true) {
				toast(`${model?.label ?? "This model"} cannot read images. Pick another model to attach them.`, "info");
				return;
			}
			const { images, problems } = await readImages(files, MAX_IMAGES_PER_MESSAGE - draft.images.length);
			for (const problem of problems) toast(problem, "info");
			setDraft((current) => ({ ...current, images: [...current.images, ...images] }));
		};

		const removeImage = (id: string) =>
			setDraft((current) => {
				const image = current.images.find((item) => item.id === id);
				if (image !== undefined) URL.revokeObjectURL(image.previewUrl);
				return { ...current, images: current.images.filter((item) => item.id !== id) };
			});

		const pick = (suggestion: Suggestion) => {
			if (token === null) return;
			const next = insertSuggestion(draft.text, token, suggestion.insert);
			setDraft((current) => ({ ...current, text: next.text }));
			setCaret(next.caret);
			requestAnimationFrame(() => textRef.current?.setSelectionRange(next.caret, next.caret));
		};

		const send = () => {
			const text = draft.text.trim();
			if (text === "" && draft.images.length === 0) return;
			const { images } = draft;
			setDraft({ text: "", images: [] });
			// A refused message comes back as a failed send above the composer, apart from the new draft.
			void sendMessage(session.id, text, images, steer);
		};

		return (
			<div className="mx-auto w-full max-w-3xl px-6 pb-4">
				{failedSends.map((failed) => (
					<FailedSendNotice key={failed.id} sessionId={session.id} failed={failed} steer={steer} />
				))}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: dropping images is an extra way in, the + button is the accessible one. */}
				<div
					className={cn(
						"relative flex flex-col rounded-xl border border-border bg-card transition-colors focus-within:border-input",
						dragging && "border-running",
					)}
					onDragOver={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={(event) => {
						event.preventDefault();
						setDragging(false);
						void addFiles([...event.dataTransfer.files]);
					}}
				>
					{suggestions.length === 0 ? null : (
						<SuggestionList
							id={suggestionsId}
							suggestions={suggestions}
							highlight={shown}
							onPick={pick}
							onHighlight={setHighlight}
						/>
					)}
					{draft.images.length === 0 ? null : (
						<div className="flex flex-wrap gap-2 px-3 pt-3">
							{draft.images.map((image) => (
								<div key={image.id} className="group relative">
									{/* biome-ignore lint/performance/noImgElement: a blob URL in a static export, which next/image cannot optimize. */}
									<img src={image.previewUrl} alt="" className="size-14 rounded-md border border-border object-cover" />
									<Button
										size="icon-xs"
										aria-label="Remove image"
										onClick={() => removeImage(image.id)}
										className="absolute -top-1.5 -right-1.5 size-4 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [&_svg:not([class*='size-'])]:size-2.5"
									>
										<XIcon />
									</Button>
								</div>
							))}
						</div>
					)}
					<Textarea
						ref={textRef}
						rows={1}
						role="combobox"
						aria-label="Message"
						aria-autocomplete="list"
						aria-expanded={suggestions.length > 0}
						aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
						aria-activedescendant={suggestions.length > 0 ? suggestionOptionId(suggestionsId, shown) : undefined}
						value={draft.text}
						placeholder={
							busy ? (steer ? "Steer the agent" : "Queue a message for when the turn ends") : "Ask for a change"
						}
						onChange={(event) => {
							// Never in a transition: a controlled field that updates late drops keys and moves the caret.
							const text = event.target.value;
							setDraft((current) => ({ ...current, text }));
							const nextCaret = event.target.selectionStart;
							setCaret(nextCaret);
							// The dismissal lasts only while that word does, so a new one gets suggestions again.
							setDismissedAt((current) => (tokenAt(text, nextCaret)?.start === current ? current : null));
						}}
						onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
						onPaste={(event) => {
							const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
							if (files.length > 0) {
								event.preventDefault();
								void addFiles(files);
							}
						}}
						onKeyDown={(event) => {
							const picked = suggestions[shown];
							if (picked !== undefined && token !== null && !event.nativeEvent.isComposing) {
								const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
								if (move !== 0) {
									event.preventDefault();
									setHighlight((shown + move + suggestions.length) % suggestions.length);
									return;
								}
								if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
									event.preventDefault();
									pick(picked);
									return;
								}
								if (event.key === "Escape") {
									event.preventDefault();
									setDismissedAt(token.start);
									return;
								}
							}
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								send();
							}
							if (event.key === "Tab" && event.shiftKey && agent !== undefined) {
								event.preventDefault();
								void updateSessionSettings(session.id, { mode: nextMode(agent.capabilities.modes, session.mode) });
							}
						}}
						className="max-h-60 min-h-11 resize-none rounded-none border-0 bg-transparent px-3.5 pt-3 pb-1 shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0 md:text-sm dark:bg-transparent"
					/>
					<div className="flex items-center gap-1 px-2 pb-2">
						<Hint label={model?.supportsImages === false ? "This model cannot read images" : "Attach images"}>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Attach images"
								disabled={model?.supportsImages === false}
								onClick={() => fileRef.current?.click()}
							>
								<PlusIcon />
							</Button>
						</Hint>
						<input
							ref={fileRef}
							type="file"
							accept="image/png,image/jpeg,image/gif,image/webp"
							multiple
							hidden
							onChange={(event) => {
								void addFiles([...(event.target.files ?? [])]);
								event.target.value = "";
							}}
						/>
						<ModePicker session={session} agent={agent} />
						<ModelPicker session={session} agent={agent} />
						<div className="flex-1" />
						<RateLimit limit={rateLimit} />
						<ContextRing usage={usage} />
						{busy ? (
							<Hint label="Stop the agent">
								<Button
									variant="secondary"
									size="icon-sm"
									aria-label="Stop"
									onClick={() =>
										void interruptSession(session.id).then((dropped) => {
											if (dropped === null || dropped.length === 0) return;
											// Queued messages never ran, so their text comes back to be edited or sent again.
											setDraft((current) => ({
												...current,
												text: [...dropped, current.text].filter((text) => text !== "").join("\n\n"),
											}));
										})
									}
								>
									<SquareIcon className="size-3 fill-current" />
								</Button>
							</Hint>
						) : null}
						<Hint label={busy ? (steer ? "Steer" : "Queue") : "Send"}>
							<Button
								variant="default"
								size="icon-sm"
								aria-label={busy ? (steer ? "Steer" : "Queue") : "Send"}
								disabled={draft.text.trim() === "" && draft.images.length === 0}
								onClick={send}
							>
								<ArrowUpIcon />
							</Button>
						</Hint>
					</div>
				</div>
			</div>
		);
	},
);

const FailedSendNotice = ({
	sessionId,
	failed,
	steer,
}: {
	readonly sessionId: string;
	readonly failed: FailedSend;
	readonly steer: boolean;
}) => (
	<div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
		<div className="min-w-0 flex-1">
			<p className="text-xs text-destructive">Not sent. {failed.error}</p>
			<p className="truncate text-muted-foreground">
				{failed.text === ""
					? `${failed.images.length} ${failed.images.length === 1 ? "image" : "images"}`
					: failed.text}
			</p>
		</div>
		<Button size="xs" variant="secondary" onClick={() => void retryFailedSend(sessionId, failed.id, steer)}>
			Retry
		</Button>
		<Button size="xs" variant="ghost" onClick={() => discardFailedSend(sessionId, failed.id)}>
			Discard
		</Button>
	</div>
);

const ModePicker = ({ session, agent }: { readonly session: AgentSession; readonly agent: AgentInfo | undefined }) => {
	const [confirming, setConfirming] = useState(false);
	if (agent === undefined || agent.capabilities.modes.length < 2) return null;
	return (
		<>
			<DropdownMenu>
				<Hint label="Shift+Tab switches modes">
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="xs"
							className={cn("text-muted-foreground", session.mode === "fullAccess" && "text-attention")}
						>
							{modeLabels[session.mode].label}
							<ChevronDownIcon />
						</Button>
					</DropdownMenuTrigger>
				</Hint>
				<DropdownMenuContent align="start" className="w-72">
					<DropdownMenuLabel className="text-xs text-muted-foreground">
						What the agent may do without asking
					</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={session.mode}
						onValueChange={(value) => {
							const mode = agent.capabilities.modes.find((item) => item === value);
							if (mode === "fullAccess") setConfirming(true);
							else if (mode !== undefined) void updateSessionSettings(session.id, { mode });
						}}
					>
						{orderedModes(agent.capabilities.modes).map((mode) => (
							<DropdownMenuRadioItem key={mode} value={mode}>
								<div className="flex flex-col">
									<span>{modeLabels[mode].label}</span>
									<span className="text-xs text-muted-foreground">{modeLabels[mode].description}</span>
								</div>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Give the agent full access?</DialogTitle>
						<DialogDescription>
							It will edit files and run any command without asking, including commands that reach outside this
							workspace. Use it only on a project you trust.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								setConfirming(false);
								void updateSessionSettings(session.id, { mode: "fullAccess" });
							}}
						>
							Allow full access
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};

const ModelPicker = ({ session, agent }: { readonly session: AgentSession; readonly agent: AgentInfo | undefined }) => {
	const model = agent?.models.find((item) => item.id === session.model);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="xs" className="text-muted-foreground">
						{model?.label ?? session.model}
						<ChevronDownIcon />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-64">
					<DropdownMenuLabel className="text-xs text-muted-foreground">
						{agent?.kind === "codex" ? "Codex" : "Claude"} model, from the next turn
					</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={session.model}
						onValueChange={(id) => {
							const next = agent?.models.find((item) => item.id === id);
							if (next !== undefined) {
								void updateSessionSettings(session.id, { model: next.id, effort: next.defaultEffort });
							}
						}}
					>
						{agent?.models.map((item) => (
							<DropdownMenuRadioItem key={item.id} value={item.id}>
								<div className="flex flex-col">
									<span>{item.label}</span>
									<span className="text-xs text-muted-foreground">{item.description}</span>
								</div>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			{model === undefined || model.efforts.length === 0 ? null : (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="xs" className="text-muted-foreground capitalize">
							{session.effort ?? model.defaultEffort ?? "Effort"}
							<ChevronDownIcon />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuLabel className="text-xs text-muted-foreground">Reasoning effort</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={session.effort ?? model.defaultEffort ?? ""}
							onValueChange={(effort) => {
								const picked = model.efforts.find((item) => item === effort);
								if (picked !== undefined) void updateSessionSettings(session.id, { effort: picked });
							}}
						>
							{model.efforts.map((effort) => (
								<DropdownMenuRadioItem key={effort} value={effort} className="capitalize">
									{effort}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</>
	);
};

const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const ContextRing = ({ usage }: { readonly usage: ChatState["usage"] }) => {
	if (usage === null || usage.contextWindow === null) return null;
	const used = Math.min(1, usage.contextTokens / usage.contextWindow);
	return (
		<Hint label={`${formatTokens(usage.contextTokens)} of ${formatTokens(usage.contextWindow)} context tokens used`}>
			<span
				className="grid size-7 place-items-center"
				role="img"
				aria-label={`${Math.round(used * 100)}% of context used`}
			>
				<svg viewBox="0 0 16 16" aria-hidden className="size-4 -rotate-90">
					<circle cx="8" cy="8" r={RING_RADIUS} fill="none" className="stroke-input" strokeWidth="2" />
					<circle
						cx="8"
						cy="8"
						r={RING_RADIUS}
						fill="none"
						className={used > 0.85 ? "stroke-attention" : "stroke-muted-foreground"}
						strokeWidth="2"
						strokeDasharray={RING_LENGTH}
						strokeDashoffset={RING_LENGTH * (1 - used)}
						strokeLinecap="round"
					/>
				</svg>
			</span>
		</Hint>
	);
};

// Shown once half of the plan window is used, or as soon as the provider warns.
const RateLimit = ({ limit }: { readonly limit: ChatState["rateLimit"] }) => {
	if (limit === null || (limit.status === "allowed" && (limit.usedPercent ?? 0) < 50)) return null;
	const used =
		limit.usedPercent === null
			? "Plan limit reached"
			: `${Math.round(limit.usedPercent)}% of ${limit.window} limit used`;
	const resets = limit.resetsAt === null ? null : formatClockTime(limit.resetsAt);
	return (
		<span className={cn("px-1 text-xs", limit.status === "allowed" ? "text-muted-foreground" : "text-attention")}>
			{resets === null ? used : `${used}, resets ${resets}`}
		</span>
	);
};
