import { TerminalInfo, TerminalNotFoundError, type TerminalSpawnError } from "@repo/contracts/Terminal";
import { Config, Context, Deferred, Effect, Exit, FiberMap, Layer, PubSub, Stream } from "effect";
import type { ProcessRegistry } from "../processes/ProcessRegistry.ts";
import type { TerminalOutput } from "@repo/contracts/Terminal";
import { spawnTerminal } from "./spawnTerminal.ts";
import type { SecureRandom } from "effect/crypto";
import { nowIso } from "../database/nowIso.ts";
import { newId } from "../database/newId.ts";
import { Scrollback } from "./Scrollback.ts";
import { basename } from "node:path";

interface Size {
	readonly cols: number;
	readonly rows: number;
}

// index orders live output against the scrollback snapshot a new client starts from.
type IndexedOutput = { readonly index: number; readonly output: TerminalOutput };

interface RunningTerminal {
	readonly info: TerminalInfo;
	readonly pty: Bun.Terminal;
	readonly pid: number;
	readonly scrollback: Scrollback;
	readonly output: PubSub.PubSub<IndexedOutput>;
	readonly appended: { count: number };
}

// A slow client loses old output rather than growing the daemon's memory. One PTY read can be large, so
// live output goes out in pieces of at most LIVE_CHUNK characters: the buffer then holds at most
// LIVE_BUFFER * LIVE_CHUNK characters, whatever the reads were.
const LIVE_BUFFER = 1024;
export const LIVE_CHUNK = 4096;

export const splitLiveOutput = (data: string): ReadonlyArray<string> => {
	const pieces: Array<string> = [];
	for (let start = 0; start < data.length; ) {
		let end = Math.min(start + LIVE_CHUNK, data.length);
		// Never between the two halves of a surrogate pair.
		const last = data.charCodeAt(end - 1);
		if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
		pieces.push(data.slice(start, end));
		start = end;
	}
	return pieces;
};

export class TerminalService extends Context.Service<TerminalService>()("octopus/daemon/terminals/TerminalService", {
	make: Effect.gen(function* () {
		const shell = yield* Config.String("SHELL").pipe(Config.withDefault("/bin/sh"));
		const services = yield* Effect.context<SecureRandom.SecureRandom | ProcessRegistry>();
		const terminals = new Map<string, RunningTerminal>();
		// One fiber per terminal owns its PTY. Interrupting it, or stopping the daemon, stops the shell
		// and everything it started.
		const fibers = yield* FiberMap.make<string>();

		const publish = (terminal: Pick<RunningTerminal, "output" | "appended">, output: TerminalOutput) => {
			terminal.appended.count++;
			PubSub.publishUnsafe(terminal.output, { index: terminal.appended.count, output });
		};

		const startPty = (info: TerminalInfo, cwd: string, size: Size) =>
			Effect.gen(function* () {
				const output = yield* PubSub.sliding<IndexedOutput>(LIVE_BUFFER);
				// After a natural exit, clients still have the exit event to read and end on it themselves. Shutting
				// down then could drop it, so only a closed terminal shuts its clients' streams.
				yield* Effect.addFinalizer((exit) => (Exit.isSuccess(exit) ? Effect.void : PubSub.shutdown(output)));
				const decoder = new TextDecoder();
				const scrollback = new Scrollback();
				const appended = { count: 0 };
				const {
					terminal: pty,
					pid,
					exited,
				} = yield* spawnTerminal({
					command: [shell, "-l"],
					cwd,
					...size,
					// The shell can print before spawnTerminal returns, so this must not need the finished terminal.
					onData: (bytes) => {
						const data = decoder.decode(bytes, { stream: true });
						scrollback.append(data);
						for (const piece of splitLiveOutput(data)) publish({ output, appended }, { type: "data", data: piece });
					},
				});
				const terminal: RunningTerminal = { info, pty, pid, scrollback, output, appended };
				return { terminal, exited };
			});

		const open = Effect.fn("TerminalService.open")(function* (workspaceId: string, cwd: string, size: Size) {
			const info = new TerminalInfo({
				id: yield* newId,
				workspaceId,
				title: basename(shell),
				createdAt: yield* nowIso,
			});
			const ready = yield* Deferred.make<void, TerminalSpawnError>();
			const run = Effect.gen(function* () {
				const { terminal, exited } = yield* startPty(info, cwd, size);
				terminals.set(info.id, terminal);
				yield* Effect.addFinalizer(() => Effect.sync(() => terminals.delete(info.id)));
				yield* Deferred.succeed(ready, undefined);
				const exitCode = yield* exited;
				// Gone from the list before clients see the exit, so a refresh never shows a dead terminal.
				terminals.delete(info.id);
				publish(terminal, { type: "exit", exitCode });
				yield* Effect.logInfo("Terminal exited").pipe(Effect.annotateLogs({ terminalId: info.id, exitCode }));
			}).pipe(
				Effect.scoped,
				Effect.catchTag("TerminalSpawnError", (error) => Deferred.fail(ready, error)),
			);
			yield* FiberMap.run(fibers, info.id, run);
			yield* Deferred.await(ready);
			yield* Effect.logInfo("Opened terminal").pipe(Effect.annotateLogs({ terminalId: info.id, workspaceId }));
			return info;
		}, Effect.provide(services));

		const find = (terminalId: string) => {
			const terminal = terminals.get(terminalId);
			return terminal === undefined ? Effect.fail(new TerminalNotFoundError({ terminalId })) : Effect.succeed(terminal);
		};

		const list = (workspaceId: string) =>
			[...terminals.values()].map((terminal) => terminal.info).filter((info) => info.workspaceId === workspaceId);

		// The shell of every open terminal, so the daemon can tell which ones are busy.
		const shellPids = () => [...terminals.values()].map((terminal) => terminal.pid);

		const attach = (terminalId: string): Stream.Stream<TerminalOutput, TerminalNotFoundError> =>
			Stream.unwrap(
				Effect.gen(function* () {
					const terminal = yield* find(terminalId);
					// Subscribe before taking the snapshot, then skip what the snapshot already holds.
					const subscription = yield* PubSub.subscribe(terminal.output);
					const snapshotIndex = terminal.appended.count;
					const snapshot: TerminalOutput = { type: "data", data: terminal.scrollback.toString() };
					return Stream.concat(
						Stream.succeed(snapshot),
						Stream.fromSubscription(subscription).pipe(
							Stream.filter((item) => item.index > snapshotIndex),
							Stream.map((item) => item.output),
							Stream.takeUntil((output) => output.type === "exit"),
						),
					);
				}),
			);

		const write = (terminalId: string, data: string) =>
			Effect.map(find(terminalId), (terminal) => {
				terminal.pty.write(data);
			});

		const resize = (terminalId: string, size: Size) =>
			Effect.map(find(terminalId), (terminal) => {
				terminal.pty.resize(size.cols, size.rows);
			});

		const close = (terminalId: string) => FiberMap.remove(fibers, terminalId);

		const closeWorkspace = (workspaceId: string) =>
			Effect.forEach(list(workspaceId), (info) => close(info.id), { discard: true });

		return { open, list, shellPids, attach, write, resize, close, closeWorkspace };
	}),
}) {
	static readonly layer = Layer.effect(TerminalService, TerminalService.make);
}
