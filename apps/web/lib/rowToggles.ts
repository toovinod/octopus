// Chat rows unmount when they scroll out of view, so a row the user opened or closed keeps that choice here. Only
// the most recent toggles are kept, which covers any chat someone scrolls through.
export const MAX_TOGGLED_ROWS = 1000;

const toggled = new Map<string, boolean>();

export const toggledRow = (rowKey: string) => toggled.get(rowKey);

export const rememberToggle = (rowKey: string, open: boolean) => {
	// Deleted first, so the Map's insertion order puts it last, as the newest.
	toggled.delete(rowKey);
	toggled.set(rowKey, open);
	if (toggled.size > MAX_TOGGLED_ROWS) {
		const oldest = toggled.keys().next();
		if (oldest.done !== true) toggled.delete(oldest.value);
	}
};
