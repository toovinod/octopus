"use client";

import { callDaemon, errorMessage, followDaemon } from "../lib/daemonRuntime.ts";
import { followTerminal, terminalInput } from "../lib/followTerminal.ts";
import type { TerminalInfo } from "@repo/contracts/Terminal";
import type { Workspace } from "@repo/contracts/Workspace";
import { useEffect, useRef, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@repo/ui/components/button";
import { toast } from "../lib/store.ts";
import { cn } from "@repo/ui/lib/utils";
import { useTheme } from "next-themes";

// Matches the daemon's scrollback, so a reattached terminal shows everything it kept.
const SCROLLBACK_LINES = 5000;
const RESIZE_SETTLE_MS = 100;

export const TerminalPanel = ({ workspace, visible }: { readonly workspace: Workspace; readonly visible: boolean }) => {
	const [terminals, setTerminals] = useState<ReadonlyArray<TerminalInfo>>([]);
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		callDaemon((daemon) => daemon.listTerminals({ workspaceId: workspace.id })).then(
			(list) => {
				if (!live) return;
				setTerminals(list);
				setSelected(list[0]?.id ?? null);
			},
			(error: unknown) => toast(errorMessage(error)),
		);
		return () => {
			live = false;
		};
	}, [workspace.id]);

	const open = async () => {
		const opened = await callDaemon((daemon) =>
			daemon.openTerminal({ workspaceId: workspace.id, cols: 80, rows: 24 }),
		).catch((error: unknown) => {
			toast(errorMessage(error));
			return null;
		});
		if (opened === null) return;
		setTerminals((current) => [...current, opened]);
		setSelected(opened.id);
	};

	// The tab stays when the daemon could not close the shell, so it can still be reached and closed again.
	const close = async (terminalId: string) => {
		const closed = await callDaemon((daemon) => daemon.closeTerminal({ terminalId })).then(
			() => true,
			(error: unknown) => {
				toast(errorMessage(error));
				return false;
			},
		);
		if (!closed) return;
		const rest = terminals.filter((terminal) => terminal.id !== terminalId);
		setTerminals((current) => current.filter((terminal) => terminal.id !== terminalId));
		setSelected((current) => (current === terminalId ? (rest.at(-1)?.id ?? null) : current));
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2">
				{terminals.map((terminal, index) => (
					<div
						key={terminal.id}
						className={cn(
							"group flex h-6 items-center gap-1 rounded-md pr-0.5 pl-2 text-xs",
							terminal.id === selected ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						<Button
							variant="ghost"
							size="xs"
							className="h-6 px-0 hover:bg-transparent dark:hover:bg-transparent"
							onClick={() => setSelected(terminal.id)}
						>
							{terminal.title || `Terminal ${index + 1}`}
						</Button>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Close terminal"
							onClick={() => void close(terminal.id)}
							className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
						>
							<XIcon />
						</Button>
					</div>
				))}
				<Button variant="ghost" size="icon-xs" aria-label="New terminal" onClick={() => void open()}>
					<PlusIcon />
				</Button>
			</div>
			{terminals.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
					<p>Terminals run in {workspace.path}.</p>
					<Button variant="secondary" size="sm" onClick={() => void open()}>
						Open a terminal
					</Button>
				</div>
			) : (
				terminals.map((terminal) => (
					<TerminalView key={terminal.id} terminalId={terminal.id} visible={visible && terminal.id === selected} />
				))
			)}
		</div>
	);
};

const cssColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Read from the page's CSS variables, so the terminal matches the light or dark theme in use.
const terminalTheme = () => ({
	background: cssColor("--background"),
	foreground: cssColor("--foreground"),
	cursor: cssColor("--foreground"),
	selectionBackground: "rgba(90, 169, 230, 0.3)",
});

// xterm touches the DOM when it loads, so it is imported in the effect, never during prerendering.
const TerminalView = ({ terminalId, visible }: { readonly terminalId: string; readonly visible: boolean }) => {
	const hostRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<(() => void) | null>(null);
	const themeRef = useRef<(() => void) | null>(null);
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		let disposed = false;
		let cleanup = () => {};
		void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([{ Terminal }, { FitAddon }]) => {
			if (disposed) return;
			const terminal = new Terminal({
				scrollback: SCROLLBACK_LINES,
				fontFamily: cssColor("--font-geist-mono") || "ui-monospace, monospace",
				fontSize: 12,
				cursorBlink: true,
				theme: terminalTheme(),
			});
			themeRef.current = () => {
				terminal.options.theme = terminalTheme();
			};
			const fit = new FitAddon();
			terminal.loadAddon(fit);
			terminal.open(host);
			// Writes and resizes after the shell exited fail harmlessly. The attach stream reports the exit.
			// Dragging the panel resizes on every frame, so only the size it settles on goes to the daemon.
			let resizeTimer: ReturnType<typeof setTimeout> | undefined;
			const resize = () => {
				if (host.clientWidth === 0) return;
				fit.fit();
				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					void callDaemon((daemon) =>
						daemon.resizeTerminal({ terminalId, cols: Math.max(2, terminal.cols), rows: Math.max(2, terminal.rows) }),
					).catch(() => undefined);
				}, RESIZE_SETTLE_MS);
			};
			fitRef.current = resize;
			const observer = new ResizeObserver(resize);
			observer.observe(host);
			const screen = { reset: () => terminal.reset(), write: (data: string) => terminal.write(data) };
			const typed = terminalInput(screen);
			const input = terminal.onData((data) => {
				void callDaemon((daemon) => daemon.writeTerminal({ terminalId, data })).then(typed.sent, typed.failed);
			});
			const stop = followTerminal(
				(follow) => followDaemon((daemon) => daemon.attachTerminal({ terminalId }), follow),
				screen,
			);
			cleanup = () => {
				clearTimeout(resizeTimer);
				stop();
				input.dispose();
				observer.disconnect();
				terminal.dispose();
			};
		});
		return () => {
			disposed = true;
			cleanup();
		};
	}, [terminalId]);

	useEffect(() => {
		if (visible) fitRef.current?.();
	}, [visible]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a theme change is the signal to read the colours again.
	useEffect(() => {
		// A frame later, once the new theme's class is on the page and its variables apply.
		const frame = requestAnimationFrame(() => themeRef.current?.());
		return () => cancelAnimationFrame(frame);
	}, [resolvedTheme]);

	return <div ref={hostRef} className={cn("min-h-0 flex-1 px-2 py-1", !visible && "hidden")} />;
};
