import { draftOf, keepDraft, releaseDrafts } from "./drafts.ts";
import { describe, expect, spyOn, test } from "bun:test";

const image = { id: "i", mediaType: "image/png", base64: "", previewUrl: "blob:preview" } as const;

describe("drafts", () => {
	test("an emptied draft is dropped", () => {
		keepDraft("a", { text: "hello", images: [] });
		expect(draftOf("a").text).toBe("hello");
		keepDraft("a", { text: "", images: [] });
		expect(draftOf("a")).toEqual({ text: "", images: [] });
	});

	test("releasing a chat's draft revokes its image previews", () => {
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		keepDraft("b", { text: "", images: [image] });
		releaseDrafts(["b", "unknown"]);
		expect(draftOf("b").images).toEqual([]);
		expect(revoke).toHaveBeenCalledWith("blob:preview");
		revoke.mockRestore();
	});
});
