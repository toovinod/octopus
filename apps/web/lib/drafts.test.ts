import { addImages, draftOf, keepDraft, releaseDrafts, withReturned } from "./drafts.ts";
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

const imageNumbered = (n: number) => ({ ...image, id: `i${n}`, previewUrl: `blob:${n}` });

describe("addImages", () => {
	test("adds only as many images as the message still has room for, and gives back the rest", () => {
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const full = [1, 2, 3].map(imageNumbered);
		const first = addImages({ text: "", images: [] }, full, 4);
		expect(first).toEqual({ draft: { text: "", images: full }, leftOut: 0 });
		// A second paste read before the first one landed still cannot pass the limit.
		const second = addImages(first.draft, [4, 5].map(imageNumbered), 4);
		expect(second.draft.images.map(({ id }) => id)).toEqual(["i1", "i2", "i3", "i4"]);
		expect(second.leftOut).toBe(1);
		expect(revoke).toHaveBeenCalledWith("blob:5");
		revoke.mockRestore();
	});
});

describe("withReturned", () => {
	test("puts the messages a stop handed back ahead of what is being typed", () => {
		const returned = withReturned(
			{ text: "still typing", images: [] },
			[
				{ text: "first", images: [] },
				{ text: "", images: [] },
				{ text: "second", images: [] },
			],
			4,
		);
		expect(returned).toEqual({ draft: { text: "first\n\nsecond\n\nstill typing", images: [] }, leftOut: 0 });
	});
});
