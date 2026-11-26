import { MAX_TOGGLED_ROWS, rememberToggle, toggledRow } from "./rowToggles.ts";
import { describe, expect, test } from "bun:test";

describe("row toggles", () => {
	test("remembers a row the user opened or closed", () => {
		rememberToggle("s:tool-1", true);
		rememberToggle("s:thinking-2", false);
		expect(toggledRow("s:tool-1")).toBe(true);
		expect(toggledRow("s:thinking-2")).toBe(false);
		expect(toggledRow("s:never")).toBeUndefined();
	});

	test("forgets the oldest toggles past the cap, so a long session cannot grow it without end", () => {
		for (let index = 0; index <= MAX_TOGGLED_ROWS; index++) rememberToggle(`row-${index}`, true);
		expect(toggledRow("row-0")).toBeUndefined();
		expect(toggledRow(`row-${MAX_TOGGLED_ROWS}`)).toBe(true);
		// Toggling again makes a row the newest, so it outlives older ones.
		rememberToggle("row-1", false);
		rememberToggle("row-new", true);
		expect(toggledRow("row-1")).toBe(false);
		expect(toggledRow("row-2")).toBeUndefined();
	});
});
