// Both CLIs report a refused credential only as text in some paths: an HTTP 401, the provider's
// authentication error, or a hint to log in again.
const authFailure =
	/\b401\b|unauthorized|authentication[_ ](error|failed)|invalid (x-)?api[ -]key|please (run \/login|log ?in|sign ?in)|not logged in/i;

export const isAuthFailureText = (text: string): boolean => authFailure.test(text);
