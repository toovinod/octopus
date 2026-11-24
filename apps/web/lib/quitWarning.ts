import type { AgentSession } from "@repo/contracts/AgentSession";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// What the desktop shell asks before quitting, or null when nothing would be lost. Quitting stops the daemon,
// which interrupts running turns and cancels pending approvals.
export const quitWarning = (sessions: Iterable<Pick<AgentSession, "status">>): string | null => {
	let running = 0;
	let waiting = 0;
	for (const session of sessions) {
		if (session.status === "running") running++;
		if (session.status === "awaitingApproval") waiting++;
	}
	if (running === 0 && waiting === 0) return null;
	const parts = [
		running === 0 ? null : count(running, "chat is working", "chats are working"),
		waiting === 0 ? null : count(waiting, "chat needs your approval", "chats need your approval"),
	].filter((part) => part !== null);
	return `${parts.join(" and ")}. Quitting stops ${running + waiting === 1 ? "it" : "them"}.`;
};
