import type { DiffFile } from "@repo/contracts/Git";

// A reload summarizes large files again, which would undo "Load the full diff". A file the user loaded in full keeps
// showing what it showed and is loaded in full again, since a summary cannot tell whether its content changed:
// equal counts can hide an edited line.
export const keepFullFiles = (
	previous: ReadonlyArray<DiffFile>,
	next: ReadonlyArray<DiffFile>,
	loadedInFull: ReadonlySet<string>,
) => {
	const loaded = new Map(
		previous
			.filter((file) => loadedInFull.has(file.path) && file.content.kind === "text")
			.map((file) => [file.path, file] as const),
	);
	const stale: Array<string> = [];
	const files = next.map((file) => {
		const before = loaded.get(file.path);
		if (file.content.kind !== "tooLarge" || before === undefined) return file;
		stale.push(file.path);
		return before;
	});
	return { files, stale };
};
