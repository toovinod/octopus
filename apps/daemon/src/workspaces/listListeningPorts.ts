import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { platform } from "node:os";
import { Effect } from "effect";

const portOf = (address: string) => {
	const match = /:(\d+)$/.exec(address);
	return match?.[1] === undefined ? null : Number(match[1]);
};

const uniqueSorted = (ports: ReadonlyArray<number | null>) =>
	[...new Set(ports.filter((port) => port !== null))].sort((a, b) => a - b);

// `lsof -Fn` prints one field per line; a name line for a TCP socket reads "n*:3000" or "n127.0.0.1:3000".
export const parseLsofPorts = (output: string) =>
	uniqueSorted(
		output
			.split("\n")
			.filter((line) => line.startsWith("n"))
			.map((line) => portOf(line.slice(1))),
	);

// `ss -ltnpH` prints "LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=42,fd=20))", for every process.
export const parseSsPorts = (output: string, pids: ReadonlySet<number>) =>
	uniqueSorted(
		output
			.split("\n")
			.filter((line) => [...line.matchAll(/pid=(\d+)/g)].some((match) => pids.has(Number(match[1]))))
			.map((line) => portOf(line.trim().split(/\s+/)[3] ?? "")),
	);

// The TCP ports that the processes of a process group listen on, such as a dev server started by the run
// script. The group leader is the script's shell, so its pid names the group. Best effort: a missing tool
// means no ports to show, which is logged.
export const listListeningPorts = Effect.fn("listListeningPorts")(
	function* (processGroup: number) {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		// Neither tool's exit code helps: both exit 1 when nothing matches.
		const read = (command: string, args: ReadonlyArray<string>) =>
			spawner.string(ChildProcess.make(command, args, { env: { LC_ALL: "C" }, extendEnv: true }));
		const pids = (yield* read("pgrep", ["-g", String(processGroup)]))
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map(Number);
		if (pids.length === 0) {
			return [];
		}
		if (platform() === "linux") {
			return parseSsPorts(yield* read("ss", ["-ltnpH"]), new Set(pids));
		}
		return parseLsofPorts(
			yield* read("lsof", ["-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fn", "-P", "-n"]),
		);
	},
	Effect.catchTag("PlatformError", (cause) =>
		Effect.logWarning("Could not list listening ports", cause).pipe(Effect.as([])),
	),
);
