import { AgentMode } from "@repo/contracts/AgentSession";

export const modeLabels: Record<AgentMode, { readonly label: string; readonly description: string }> = {
	readOnly: { label: "Read only", description: "Reads and runs safe commands. Changes nothing." },
	plan: { label: "Plan", description: "Researches and proposes a plan for you to approve." },
	ask: { label: "Ask", description: "Asks before editing files or running commands." },
	acceptEdits: { label: "Accept edits", description: "Edits files freely. Asks before commands." },
	auto: { label: "Auto", description: "Works on its own and asks before anything risky." },
	fullAccess: { label: "Full access", description: "Never asks. Runs any command. Trusted projects only." },
};

// The agent's modes from least to most freedom, whatever order the agent lists them in.
export const orderedModes = (offered: ReadonlyArray<AgentMode>): ReadonlyArray<AgentMode> =>
	AgentMode.literals.filter((mode) => offered.includes(mode));

// Shift+Tab steps through the modes but never into full access, which needs a confirmation.
export const nextMode = (offered: ReadonlyArray<AgentMode>, current: AgentMode): AgentMode => {
	const cycle: ReadonlyArray<AgentMode> = orderedModes(offered).filter((mode) => mode !== "fullAccess");
	const index = cycle.indexOf(current);
	return cycle[(index + 1) % cycle.length] ?? current;
};
