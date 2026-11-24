import { insertSuggestion, matchCommands, tokenAt } from "./composerSuggestions.ts";
import { describe, expect, test } from "bun:test";

describe("composer suggestions", () => {
	test("finds the word at the caret when it starts with a trigger", () => {
		expect(tokenAt("/rev", 4)).toEqual({ trigger: "/", query: "rev", start: 0, end: 4 });
		expect(tokenAt("look at @src/ma", 15)).toEqual({ trigger: "@", query: "src/ma", start: 8, end: 15 });
		expect(tokenAt("use $te please", 7)).toEqual({ trigger: "$", query: "te", start: 4, end: 7 });
	});

	test("ignores a slash after the start, an @ inside a word, and plain words", () => {
		expect(tokenAt("see /tmp", 8)).toBeNull();
		expect(tokenAt("mail a@b.com", 12)).toBeNull();
		expect(tokenAt("hello", 5)).toBeNull();
		expect(tokenAt("@x ", 3)).toBeNull();
	});

	test("replaces the whole word, even past the caret, and adds one space", () => {
		const token = tokenAt("read @src/ma now", 11);
		expect(token).not.toBeNull();
		if (token === null) return;
		expect(insertSuggestion("read @src/mainly now", token, "@src/main.ts")).toEqual({
			text: "read @src/main.ts now",
			caret: 18,
		});
		expect(insertSuggestion("/re", { trigger: "/", query: "re", start: 0, end: 3 }, "/review")).toEqual({
			text: "/review ",
			caret: 8,
		});
	});

	test("matches commands by what was typed, including the prefix", () => {
		const commands = [
			{ name: "/review", description: "", argumentHint: null },
			{ name: "/compact", description: "", argumentHint: null },
			{ name: "$tester", description: "", argumentHint: null },
		];
		expect(matchCommands(commands, { trigger: "/", query: "RE", start: 0, end: 3 }).map(({ name }) => name)).toEqual([
			"/review",
		]);
		expect(matchCommands(commands, { trigger: "$", query: "", start: 0, end: 1 }).map(({ name }) => name)).toEqual([
			"$tester",
		]);
	});
});
