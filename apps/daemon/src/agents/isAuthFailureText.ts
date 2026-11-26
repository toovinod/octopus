// Claude Code and Codex report a refused credential only as text in some paths: an "API Error: 401", the
// provider's authentication error, or a hint to log in again. A bare "401" or "unauthorized" is not enough,
// since a turn's error or a tool's output often quotes one that has nothing to do with the agent's own login,
// and neither is a tool's "not logged into" some other service.
const authFailure =
	/\bAPI Error: 401\b|authentication[_ ](error|failed)|invalid (x-)?api[ -]key|run \/login\b|please (log ?in|sign ?in) again|\bnot logged in\b/i;

export const isAuthFailureText = (text: string): boolean => authFailure.test(text);
