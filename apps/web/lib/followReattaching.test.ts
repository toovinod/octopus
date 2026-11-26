import { followReattaching } from "./followReattaching.ts";
import { describe, expect, test } from "bun:test";
import type { Follow } from "./daemonRuntime.ts";

const drop = { _tag: "RpcClientError", message: "SocketCloseError: closed" };
const permanent = { _tag: "WorkspaceNotFoundError", message: "This workspace is gone." };

// A stream that replays "a" on every attach, fails the first attach, and ends on the second.
const droppingOnce = (failure: unknown = drop) => {
	let attaches = 0;
	const follow = (handlers: Follow<string>) => {
		attaches++;
		handlers.onItem("a");
		if (attaches === 1) handlers.onEnd?.(failure);
		else {
			handlers.onItem("b");
			handlers.onEnd?.(null);
		}
		return () => undefined;
	};
	return { follow, attaches: () => attaches };
};

describe("followReattaching", () => {
	test("attaches to the same stream again after the connection drops", async () => {
		const stream = droppingOnce();
		const seen: Array<string> = [];
		const ended = await new Promise<unknown>((resolve) => {
			followReattaching(stream.follow, {
				onItem: (item) => seen.push(item),
				onReattach: () => seen.push("reattached"),
				onEnd: resolve,
			});
		});
		expect(ended).toBeNull();
		expect(seen).toEqual(["a", "reattached", "a", "b"]);
		expect(stream.attaches()).toBe(2);
	});

	test("a failure other than a dropped connection ends the follow instead of retrying forever", async () => {
		const stream = droppingOnce(permanent);
		const drops: Array<unknown> = [];
		const ended = await new Promise<unknown>((resolve) => {
			followReattaching(stream.follow, {
				onItem: () => undefined,
				onReattach: () => undefined,
				onDrop: (error) => drops.push(error),
				onEnd: resolve,
			});
		});
		await Bun.sleep(1500);
		expect(ended).toBe(permanent);
		expect(drops).toEqual([]);
		expect(stream.attaches()).toBe(1);
	});

	test("onDrop hears about each dropped connection", async () => {
		const stream = droppingOnce();
		const drops: Array<unknown> = [];
		followReattaching(stream.follow, {
			onItem: () => undefined,
			onReattach: () => undefined,
			onDrop: (error) => drops.push(error),
		});
		await Bun.sleep(1500);
		expect(drops).toEqual([drop]);
		expect(stream.attaches()).toBe(2);
	});

	test("stopping while waiting to reattach stops for good", async () => {
		const stream = droppingOnce();
		const stop = followReattaching(stream.follow, { onItem: () => undefined, onReattach: () => undefined });
		stop();
		await Bun.sleep(1500);
		expect(stream.attaches()).toBe(1);
	});
});
