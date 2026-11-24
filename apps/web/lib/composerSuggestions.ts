import type { AgentCommand } from "@repo/contracts/AgentSession";

// What the word at the caret asks for: "/" a slash command (only to start the message, as Claude
// Code reads them), "$" a Codex skill, "@" a file.
export interface SuggestionToken {
	readonly trigger: "/" | "$" | "@";
	readonly query: string;
	readonly start: number;
	readonly end: number;
}

export const tokenAt = (text: string, caret: number): SuggestionToken | null => {
	const start = text.slice(0, caret).search(/\S*$/);
	const trigger = text[start];
	if (trigger !== "/" && trigger !== "$" && trigger !== "@") return null;
	if (trigger === "/" && start !== 0) return null;
	return { trigger, query: text.slice(start + 1, caret), start, end: caret };
};

// Replaces the word with the pick and a space, and says where the caret goes.
export const insertSuggestion = (text: string, token: SuggestionToken, value: string) => {
	const before = `${text.slice(0, token.start)}${value} `;
	const after = text.slice(token.end).replace(/^\S*/, "").replace(/^ /, "");
	return { text: before + after, caret: before.length };
};

export const matchCommands = (
	commands: ReadonlyArray<AgentCommand>,
	token: SuggestionToken,
): ReadonlyArray<AgentCommand> => {
	const typed = `${token.trigger}${token.query}`.toLowerCase();
	return commands.filter(({ name }) => name.toLowerCase().startsWith(typed));
};
