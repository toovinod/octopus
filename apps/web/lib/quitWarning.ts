import type { WorkspaceActivity } from "@repo/contracts/Workspace";
import type { AgentSession } from "@repo/contracts/AgentSession";

const count = (n: number, one: string, many: string) => (n === 0 ? null : `${n} ${n === 1 ? one : many}`);

const listed = (parts: ReadonlyArray<string>) =>
	parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

// What the desktop shell asks before quitting, or null when nothing would be lost. Quitting stops the daemon,
// which interrupts running turns, cancels pending approvals and stops terminals and scripts.
export const quitWarning = (
	sessions: Iterable<Pick<AgentSession, "status">>,
	activity: Pick<WorkspaceActivity, "busyTerminals" | "runningScripts">,
): string | null => {
	let running = 0;
	let waiting = 0;
	for (const session of sessions) {
		if (session.status === "running") running++;
		if (session.status === "awaitingApproval") waiting++;
	}
	const parts = [
		count(running, "chat is working", "chats are working"),
		count(waiting, "chat needs your approval", "chats need your approval"),
		count(activity.busyTerminals, "terminal is running a command", "terminals are running a command"),
		count(activity.runningScripts, "script is running", "scripts are running"),
	].filter((part) => part !== null);
	if (parts.length === 0) return null;
	const total = running + waiting + activity.busyTerminals + activity.runningScripts;
	return `${listed(parts)}. Quitting stops ${total === 1 ? "it" : "them"}.`;
};
