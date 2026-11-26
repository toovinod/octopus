import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

// What the desktop shell adds over a browser. In a browser during development these fall back or do nothing.
export const isDesktop = () => isTauri();

export const pickFolder = async (title: string) => {
	const picked = await open({ directory: true, multiple: false, title });
	return typeof picked === "string" ? picked : null;
};

// Links go to the system browser. Navigating the app's own window would hand the page, and the IPC bridge it
// holds, to whatever site the link points at.
export const openExternal = async (url: string) => {
	if (isDesktop()) await openUrl(url);
	else window.open(url, "_blank", "noreferrer");
};

// The shell asks with this text before it quits. Must match the command in apps/desktop/src-tauri/src/lib.rs.
export const setQuitWarning = async (warning: string | null) => {
	if (isDesktop()) await invoke("set_quit_warning", { warning });
};

// Must match QUIT_CHECK_EVENT in apps/desktop/src-tauri/src/lib.rs.
const QUIT_CHECK_EVENT = "quit-check";

// Before a quit that would ask first, the shell has the webview bring its warning up to date, and waits a moment
// for it to say it is done. Returns the function that stops listening.
export const onQuitCheck = (check: () => Promise<void>) => {
	if (!isDesktop()) return () => {};
	const unlisten = listen(QUIT_CHECK_EVENT, () => {
		void check().finally(() => invoke("quit_checked"));
	});
	return () => void unlisten.then((stop) => stop());
};

// Whether the shell had to start the daemon without the login shell's environment, so without the user's PATH.
// Must match the command in apps/desktop/src-tauri/src/lib.rs.
export const loginEnvMissing = async () => isDesktop() && (await invoke<unknown>("login_env_missing")) === true;

let permission: Promise<boolean> | null = null;

const canNotify = () => {
	permission ??= isPermissionGranted().then((granted) =>
		granted ? true : requestPermission().then((answer) => answer === "granted"),
	);
	return permission;
};

export const showNotification = async (title: string, body: string) => {
	if (isDesktop() && (await canNotify())) {
		sendNotification({ title, body });
	}
};

let chime: HTMLAudioElement | null = null;

export const playChime = () => {
	chime ??= new Audio("/chime.wav");
	chime.currentTime = 0;
	// Autoplay rules can refuse sound before the user has clicked anything. Silence is the right fallback.
	chime.play().catch(() => undefined);
};
