"use client";

import { OctopusLogo } from "./OctopusLogo.tsx";
import { boot, closeTab, newChat, onWindowFocus, openDialog, setPanel, useAppState } from "../lib/store.ts";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from "@repo/ui/components/resizable";
import { isReason, onDaemonStopped, restartDaemon } from "../lib/daemonRuntime.ts";
import { isMac, shortcutKey } from "../lib/shortcutKey.ts";
import { quitWarning } from "../lib/quitWarning.ts";
import { setQuitWarning } from "../lib/desktop.ts";
import { SidebarProvider } from "@repo/ui/components/sidebar";
import { TooltipProvider } from "@repo/ui/components/tooltip";
import { Toaster } from "@repo/ui/components/sonner";
import { Button } from "@repo/ui/components/button";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog.tsx";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog.tsx";
import { RemoveProjectDialog } from "./RemoveProjectDialog.tsx";
import { RevertDialog } from "./RevertDialog.tsx";
import { NewProjectDialog } from "./NewProjectDialog.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { getState } from "../lib/store.ts";
import { SidePanel } from "./SidePanel.tsx";
import { ChatView } from "./ChatView.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { useEffect, useState } from "react";

const useShortcuts = () =>
	useEffect(() => {
		const mac = isMac();
		const onKey = (event: KeyboardEvent) => {
			const dialogOpen = document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
			const key = shortcutKey(event, mac, dialogOpen);
			if (key === null) return;
			const { selectedSessionId, panel } = getState();
			const action =
				key === "k"
					? () => openDialog({ kind: "palette" })
					: key === "t"
						? () => void newChat()
						: key === ","
							? () => openDialog({ kind: "settings", tab: "accounts" })
							: key === "w" && selectedSessionId !== null
								? () => closeTab(selectedSessionId)
								: key === "\\"
									? () => setPanel({ open: !panel.open })
									: null;
			if (action === null) return;
			event.preventDefault();
			action();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("focus", onWindowFocus);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("focus", onWindowFocus);
		};
	}, []);

// Keeps the shell's quit warning current, so quitting asks first while turns run or approvals wait.
const useQuitWarning = () => {
	const warning = useAppState((current) => quitWarning(Object.values(current.sessions)));
	useEffect(() => {
		void setQuitWarning(warning);
	}, [warning]);
};

// null while the daemon runs; once it stops, the reason it gave, if any.
const useDaemonStopped = () => {
	const [stopped, setStopped] = useState<{ reason: string | null } | null>(null);
	useEffect(() => onDaemonStopped((reason) => setStopped({ reason })), []);
	return stopped;
};

// The user restarts the daemon, never a timer, so a daemon that crashes on start does not restart in a loop.
const DaemonStopped = ({ reason }: { reason: string | null }) => {
	const [restart, setRestart] = useState<"idle" | "restarting" | "failed">("idle");
	const [failure, setFailure] = useState(reason);
	const onRestart = () => {
		setRestart("restarting");
		restartDaemon().catch((error: unknown) => {
			// The shell rejects with the daemon's own reason when it printed one.
			if (isReason(error)) setFailure(error);
			setRestart("failed");
		});
	};
	return (
		<main className="flex h-full flex-col items-center justify-center gap-2 text-center">
			<OctopusLogo className="size-10" />
			<p className="font-medium">Octopus lost its daemon.</p>
			<p className="max-w-sm text-sm text-muted-foreground">
				{restart === "failed"
					? "Octopus could not start its daemon again. Quit Octopus and open it again."
					: "Agents and terminals that were running have stopped. Restart the daemon to reconnect."}
			</p>
			{failure === null ? null : <p className="max-w-sm text-sm text-muted-foreground">{failure}</p>}
			<Button size="sm" className="mt-2" disabled={restart === "restarting"} onClick={onRestart}>
				{restart === "restarting" ? "Restarting" : "Restart"}
			</Button>
		</main>
	);
};

// Starts the daemon again if it stopped, then reloads, so the app connects from scratch.
const RetryConnection = () => {
	const [retrying, setRetrying] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const onRetry = () => {
		setRetrying(true);
		restartDaemon().catch((error: unknown) => {
			setFailure(isReason(error) ? error : "Octopus could not start its daemon. Quit Octopus and open it again.");
			setRetrying(false);
		});
	};
	return (
		<>
			{failure === null ? null : <p className="max-w-sm text-sm text-muted-foreground">{failure}</p>}
			<Button size="sm" className="mt-2" disabled={retrying} onClick={onRetry}>
				{retrying ? "Retrying" : "Retry"}
			</Button>
		</>
	);
};

export const App = () => {
	const connection = useAppState((current) => current.connection);
	const panelOpen = useAppState((current) => current.panel.open);
	const hasWorkspace = useAppState((current) => current.selectedWorkspaceId !== null);
	const daemonStopped = useDaemonStopped();
	const panelRef = usePanelRef();
	useShortcuts();
	useQuitWarning();
	useEffect(() => {
		void boot();
	}, []);

	// Closing collapses the panel instead of unmounting it, so terminals, loaded diffs and scroll positions survive.
	// A frame later, because a panel that just mounted has not told its group its size limits yet, and resizing it
	// before then throws.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the panel mounts again when a workspace is picked.
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const panel = panelRef.current;
			if (panel === null) return;
			if (panelOpen) panel.expand();
			else panel.collapse();
		});
		return () => cancelAnimationFrame(frame);
	}, [panelOpen, panelRef, hasWorkspace]);

	if (daemonStopped !== null) return <DaemonStopped reason={daemonStopped.reason} />;

	if (connection.status === "connecting" || connection.status === "failed") {
		return (
			<main className="flex h-full flex-col items-center justify-center gap-2 text-center">
				<OctopusLogo className="size-10" />
				<p className="font-medium">Octopus</p>
				<p className="max-w-sm text-sm text-muted-foreground">
					{connection.status === "failed" ? connection.message : "Connecting to the daemon"}
				</p>
				{connection.status === "failed" ? <RetryConnection /> : null}
			</main>
		);
	}

	return (
		<SidebarProvider className="h-full min-h-0">
			<TooltipProvider delayDuration={400}>
				<ResizablePanelGroup>
					<ResizablePanel id="sidebar" defaultSize="18" minSize={200} maxSize="30">
						<Sidebar />
					</ResizablePanel>
					<ResizableHandle />
					<ResizablePanel id="chat" minSize={360}>
						<ChatView />
					</ResizablePanel>
					{hasWorkspace ? (
						<>
							<ResizableHandle />
							<ResizablePanel
								id="panel"
								panelRef={panelRef}
								defaultSize="36"
								minSize={320}
								collapsible
								collapsedSize={0}
								// Dragging the panel shut or open counts as closing or opening it.
								onResize={() => {
									const collapsed = panelRef.current?.isCollapsed();
									if (collapsed !== undefined && collapsed === getState().panel.open) setPanel({ open: !collapsed });
								}}
							>
								<SidePanel />
							</ResizablePanel>
						</>
					) : null}
				</ResizablePanelGroup>
				<CommandPalette />
				<NewProjectDialog />
				<NewWorkspaceDialog />
				<RemoveProjectDialog />
				<RevertDialog />
				<WorkspaceSettingsDialog />
				<SettingsDialog />
				<Toaster position="bottom-right" />
			</TooltipProvider>
		</SidebarProvider>
	);
};
