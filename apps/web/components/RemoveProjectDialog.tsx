"use client";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/components/dialog";
import { openDialog, removeProject, useAppState } from "../lib/store.ts";
import { Button } from "@repo/ui/components/button";
import { useState } from "react";

export const RemoveProjectDialog = () => {
	const dialog = useAppState((current) => current.dialog);
	const projectId = dialog?.kind === "removeProject" ? dialog.projectId : null;
	const project = useAppState((current) => (projectId === null ? undefined : current.projects[projectId]));
	const [busy, setBusy] = useState(false);
	const remove = async (id: string) => {
		setBusy(true);
		// A refusal, such as active workspaces, shows as a toast and leaves the dialog open.
		if (await removeProject(id)) openDialog(null);
		setBusy(false);
	};
	return (
		<Dialog open={project !== undefined} onOpenChange={(next) => !next && openDialog(null)}>
			{project === undefined ? null : (
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove {project.name} from Octopus?</DialogTitle>
						<DialogDescription>
							Its archived workspaces and their chats leave Octopus too. The folder and its branches stay on disk.
							Archive its active workspaces first.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="ghost" onClick={() => openDialog(null)}>
							Cancel
						</Button>
						<Button variant="destructive" disabled={busy} onClick={() => void remove(project.id)}>
							Remove
						</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
};
