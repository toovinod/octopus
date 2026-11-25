// Agents link files they mention, as "src/app.ts", "./src/app.ts:12" or an absolute path inside the workspace.
// Returns the path relative to the workspace root, or null for a web link or a path outside the workspace.
export const workspaceLinkPath = (href: string, workspacePath: string): string | null => {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
	const encoded = href.replace(/[?#].*$/, "");
	// A stray "%" is not an escape, and decoding it would throw.
	if (/%(?![0-9a-f]{2})/i.test(encoded)) return null;
	const path = decodeURIComponent(encoded).replace(/:\d+(:\d+)?$/, "");
	const root = workspacePath.replace(/\/+$/, "");
	const relative = path.startsWith(`${root}/`)
		? path.slice(root.length + 1)
		: path.startsWith("/")
			? null
			: path.replace(/^(\.\/)+/, "");
	if (relative === null || relative === "" || relative.split("/").includes("..")) return null;
	return relative;
};
