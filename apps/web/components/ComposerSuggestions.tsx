"use client";

import { matchCommands, type SuggestionToken } from "../lib/composerSuggestions.ts";
import type { AgentCommand, AgentSession } from "@repo/contracts/AgentSession";
import { listSessionCommands, searchFiles } from "../lib/store.ts";
import { FileIcon, SlashIcon } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useEffect, useState } from "react";

export interface Suggestion {
	readonly key: string;
	// What replaces the word at the caret.
	readonly insert: string;
	readonly label: string;
	readonly detail: string | null;
	readonly kind: "command" | "file";
}

// Waits this long after the last key before searching files.
const FILE_SEARCH_DELAY_MS = 80;

export const useSuggestions = (session: AgentSession, token: SuggestionToken | null): ReadonlyArray<Suggestion> => {
	const [commands, setCommands] = useState<ReadonlyArray<AgentCommand>>([]);
	const [files, setFiles] = useState<ReadonlyArray<string>>([]);
	const wantsCommands = token !== null && token.trigger !== "@";
	const fileQuery = token?.trigger === "@" ? token.query : null;

	// Fetched each time a command word starts, since skills and commands can change while the agent runs.
	useEffect(() => {
		if (!wantsCommands) return;
		let live = true;
		void listSessionCommands(session.id).then((listed) => {
			if (live && listed !== null) setCommands(listed);
		});
		return () => {
			live = false;
		};
	}, [session.id, wantsCommands]);

	useEffect(() => {
		if (fileQuery === null) return;
		let live = true;
		const timer = setTimeout(() => {
			void searchFiles(session.workspaceId, fileQuery).then((found) => {
				if (live && found !== null) setFiles(found);
			});
		}, FILE_SEARCH_DELAY_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [session.workspaceId, fileQuery]);

	if (token === null) return [];
	if (token.trigger === "@") {
		return files.map((path) => ({ key: path, insert: `@${path}`, label: path, detail: null, kind: "file" }));
	}
	return matchCommands(commands, token).map(({ name, description, argumentHint }) => ({
		key: name,
		insert: name,
		label: argumentHint === null ? name : `${name} ${argumentHint}`,
		detail: description === "" ? null : description,
		kind: "command",
	}));
};

// The text field points at the list and its highlighted option by these ids, so screen readers follow along.
export const suggestionOptionId = (listId: string, index: number) => `${listId}-${index}`;

export const SuggestionList = ({
	id,
	suggestions,
	highlight,
	onPick,
	onHighlight,
}: {
	readonly id: string;
	readonly suggestions: ReadonlyArray<Suggestion>;
	readonly highlight: number;
	readonly onPick: (suggestion: Suggestion) => void;
	readonly onHighlight: (index: number) => void;
}) => (
	<div
		id={id}
		role="listbox"
		aria-label="Suggestions"
		className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-md"
	>
		{suggestions.map((suggestion, index) => (
			<div
				key={suggestion.key}
				id={suggestionOptionId(id, index)}
				role="option"
				tabIndex={-1}
				aria-selected={index === highlight}
				ref={(element) => {
					if (index === highlight) element?.scrollIntoView({ block: "nearest" });
				}}
				// Mouse down, not click, so the text field keeps its focus and caret.
				onMouseDown={(event) => {
					event.preventDefault();
					onPick(suggestion);
				}}
				onMouseEnter={() => onHighlight(index)}
				className={cn(
					"flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
					index === highlight && "bg-accent text-accent-foreground",
				)}
			>
				{suggestion.kind === "file" ? (
					<FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<SlashIcon className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className="shrink-0 truncate font-mono text-xs">{suggestion.label}</span>
				{suggestion.detail === null ? null : (
					<span className="min-w-0 truncate text-xs text-muted-foreground">{suggestion.detail}</span>
				)}
			</div>
		))}
	</div>
);
