import { commentsOf, keepComments, releaseComments } from "./pendingComments.ts";
import { describe, expect, test } from "bun:test";

const comment = { id: "c", path: "a.ts", side: "new", start: 1, end: 1, code: ["x"], text: "rename" } as const;

describe("pending diff comments", () => {
	test("keeps a workspace's unsent comments until they are sent or its workspace goes", () => {
		keepComments("w1", [comment]);
		keepComments("w2", [comment]);
		expect(commentsOf("w1")).toEqual([comment]);
		releaseComments(["w1"]);
		expect(commentsOf("w1")).toEqual([]);
		expect(commentsOf("w2")).toEqual([comment]);
		keepComments("w2", []);
		expect(commentsOf("w2")).toEqual([]);
	});
});
