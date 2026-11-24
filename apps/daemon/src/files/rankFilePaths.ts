// Lower is a better match: the file name starts with the query, then contains it, then the path
// contains it, then the query's letters appear in order. Null means no match.
const scoreOf = (path: string, query: string): number | null => {
	const lower = path.toLowerCase();
	const name = lower.slice(lower.lastIndexOf("/") + 1);
	if (name.startsWith(query)) return 0;
	if (name.includes(query)) return 1;
	if (lower.includes(query)) return 2;
	let at = 0;
	for (const char of lower) {
		if (char === query[at]) at++;
		if (at === query.length) return 3;
	}
	return null;
};

// The best `limit` paths for what the user typed after "@". Ties go to the shorter path.
export const rankFilePaths = (paths: ReadonlyArray<string>, query: string, limit: number): ReadonlyArray<string> => {
	const wanted = query.toLowerCase();
	return paths
		.flatMap((path) => {
			const score = scoreOf(path, wanted);
			return score === null ? [] : [{ path, score }];
		})
		.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
		.slice(0, limit)
		.map(({ path }) => path);
};
