import { terminalHasChild } from "./terminalHasChild.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

const hasChild = (pid: number) => terminalHasChild(pid).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

describe("terminalHasChild", () => {
	test("a shell running a command is busy", async () => {
		// The trailing command keeps sh from replacing itself with sleep.
		const shell = Bun.spawn(["/bin/sh", "-c", "sleep 5; true"]);
		await Bun.sleep(200);
		expect(await hasChild(shell.pid)).toBe(true);
		shell.kill("SIGKILL");
	});

	test("a shell waiting at its prompt is not busy", async () => {
		const idle = Bun.spawn(["sleep", "5"]);
		expect(await hasChild(idle.pid)).toBe(false);
		idle.kill("SIGKILL");
	});
});
