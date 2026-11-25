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
