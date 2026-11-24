"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { openDialog, previewRevert, revertToMessage, useAppState } from "../lib/store.ts";
import type { CheckpointChange } from "@repo/contracts/Checkpoint";
import { Button } from "@repo/ui/components/button";
import { useEffect, useState } from "react";

const CHANGE_LABELS: Record<CheckpointChange["change"], string> = {
	added: "Removed",
	modified: "Restored",
	deleted: "Brought back",
};

// Shows what a revert undoes before it runs, since it rewrites files every chat in the workspace shares.
export const RevertDialog = () => {
	const dialog = useAppState((current) => current.dialog);
	const target = dialog?.kind === "revert" ? dialog : null;
	const [changes, setChanges] = useState<ReadonlyArray<CheckpointChange> | null>(null);
	const [busy, setBusy] = useState(false);
	const sessionId = target?.sessionId;
	const messageId = target?.messageId;

	useEffect(() => {
		setChanges(null);
		if (sessionId === undefined || messageId === undefined) return;
		let current = true;
		void previewRevert(sessionId, messageId).then((preview) => {
			if (!current) return;
			// A refusal, such as a message from before checkpoints, already showed as a toast.
			if (preview === null) openDialog(null);
			else setChanges(preview);
		});
		return () => {
			current = false;
		};
	}, [sessionId, messageId]);

	const revert = async (session: string, message: string) => {
		setBusy(true);
		if (await revertToMessage(session, message)) openDialog(null);
		setBusy(false);
	};

	return (
		<Dialog open={target !== null} onOpenChange={(next) => !next && openDialog(null)}>
			{target === null ? null : (
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Revert files to before this message?</DialogTitle>
						<DialogDescription>
							Every chat in this workspace shares its folder, so their changes since then are undone too. The chat
							history stays as it is.
						</DialogDescription>
					</DialogHeader>
					{changes === null ? (
						<p className="text-sm text-muted-foreground">Checking what changed...</p>
					) : changes.length === 0 ? (
						<p className="text-sm text-muted-foreground">Nothing changed since this message.</p>
					) : (
						<ul className="max-h-64 overflow-y-auto rounded-md border text-sm">
							{changes.map((change) => (
								<li key={change.path} className="flex justify-between gap-3 px-3 py-1.5">
									<span className="truncate font-mono text-xs">{change.path}</span>
									<span className="shrink-0 text-xs text-muted-foreground">{CHANGE_LABELS[change.change]}</span>
								</li>
							))}
						</ul>
					)}
					<DialogFooter>
						<Button variant="ghost" onClick={() => openDialog(null)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={busy || changes === null || changes.length === 0}
							onClick={() => void revert(target.sessionId, target.messageId)}
						>
							Revert
						</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
};
