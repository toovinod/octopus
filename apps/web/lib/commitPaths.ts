import type { DiffFile } from "@repo/contracts/Git";

// What to commit: null, meaning every change, while no file is unticked. A rename brings its old path along, so the
// deletion lands in the same commit.
export const commitPaths = (
	files: ReadonlyArray<Pick<DiffFile, "path" | "oldPath">>,
	excluded: ReadonlySet<string>,
): ReadonlyArray<string> | null =>
	excluded.size === 0
		? null
		: files
				.filter((file) => !excluded.has(file.path))
				.flatMap((file) => (file.oldPath === null ? [file.path] : [file.path, file.oldPath]));
