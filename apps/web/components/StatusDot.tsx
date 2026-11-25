import type { AgentSessionStatus } from "@repo/contracts/AgentSession";
import type { Attention } from "../lib/store.ts";
import { cn } from "@repo/ui/lib/utils";

// Running pulses, approval and failure get their colors, and finished work the user has not seen yet
// shows a filled dot. Idle chats show nothing, so the sidebar stays quiet.
export const StatusDot = ({
	status,
	attention,
	className,
}: {
	readonly status: AgentSessionStatus | null;
	readonly attention?: Attention | undefined;
	readonly className?: string;
}) => {
	const shown =
		status === "awaitingApproval" || attention === "approval"
			? { tone: "bg-attention", label: "Needs approval" }
			: status === "failed" || attention === "failed"
				? { tone: "bg-destructive", label: "Failed" }
				: status === "running"
					? { tone: "bg-running animate-pulse", label: "Working" }
					: attention === "done"
						? { tone: "bg-success", label: "Finished" }
						: null;
	// Named for screen readers, since the colour alone says nothing to them.
	return shown === null ? (
		<span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-transparent", className)} />
	) : (
		<span role="img" aria-label={shown.label} className={cn("size-1.5 shrink-0 rounded-full", shown.tone, className)} />
	);
};
