// Both CLIs report a refused credential only as text in some paths: Claude Code's "API Error: 401", the
// provider's authentication error, or a hint to log in again. A bare "401" or "unauthorized" is not enough,
// since a turn's error or a tool's output often quotes one that has nothing to do with the agent's own login.
const authFailure =
	/\bAPI Error: 401\b|authentication[_ ](error|failed)|invalid (x-)?api[ -]key|run \/login\b|please (log ?in|sign ?in) again|not logged in/i;

export const isAuthFailureText = (text: string): boolean => authFailure.test(text);
