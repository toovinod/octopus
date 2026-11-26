import { shortcutKey, shortcutLabel } from "./shortcutKey.ts";
import { describe, expect, test } from "bun:test";

const press = (key: string, modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean; repeat?: boolean } = {}) => ({
	key,
	metaKey: modifiers.meta ?? false,
	ctrlKey: modifiers.ctrl ?? false,
	altKey: modifiers.alt ?? false,
	repeat: modifiers.repeat ?? false,
});

describe("shortcutKey", () => {
	test("uses Cmd on macOS and leaves Ctrl to text editing", () => {
		expect(shortcutKey(press("T", { meta: true }), true, false)).toBe("t");
		expect(shortcutKey(press("t", { ctrl: true }), true, false)).toBeNull();
		expect(shortcutKey(press("k", { ctrl: true }), true, false)).toBeNull();
	});

	test("uses Ctrl elsewhere", () => {
		expect(shortcutKey(press("w", { ctrl: true }), false, false)).toBe("w");
		expect(shortcutKey(press("w", { meta: true }), false, false)).toBeNull();
	});

	test("ignores held keys, Alt and open dialogs", () => {
		expect(shortcutKey(press("t", { meta: true, repeat: true }), true, false)).toBeNull();
		expect(shortcutKey(press("t", { meta: true, alt: true }), true, false)).toBeNull();
		expect(shortcutKey(press("t", { meta: true }), true, true)).toBeNull();
	});
});

describe("shortcutLabel", () => {
	test("shows the key that makes the shortcut on this system", () => {
		expect(shortcutLabel("T", true)).toBe("⌘T");
		expect(shortcutLabel("T", false)).toBe("Ctrl+T");
		expect(shortcutLabel(",", false)).toBe("Ctrl+,");
	});
});
