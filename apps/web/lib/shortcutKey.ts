import { useSyncExternalStore } from "react";

// On macOS only Cmd makes a shortcut, because Ctrl+K, Ctrl+T and Ctrl+W edit text there. Elsewhere it is Ctrl.
// A held key repeats, and an open dialog owns the keyboard, so neither triggers one.
export const shortcutKey = (
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "repeat">,
	mac: boolean,
	dialogOpen: boolean,
): string | null => {
	const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	if (!modifier || event.altKey || event.repeat || dialogOpen) return null;
	return event.key.toLowerCase();
};

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

// What a hint shows for the shortcut, matching the modifier shortcutKey listens for.
export const shortcutLabel = (key: string, mac: boolean) => (mac ? `⌘${key}` : `Ctrl+${key}`);

const neverChanges = () => () => {};

// The page is prerendered without a navigator, so the first render assumes macOS and corrects itself on the client.
export const useShortcutLabel = (key: string) =>
	shortcutLabel(
		key,
		useSyncExternalStore(neverChanges, isMac, () => true),
	);
