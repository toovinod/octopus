import { saveForReload, takeSavedForReload } from "./keepAcrossReload.ts";
import { describe, expect, test } from "bun:test";

const memoryStorage = (quota = Number.POSITIVE_INFINITY) => {
	const items = new Map<string, string>();
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			if (value.length > quota) throw new Error("QuotaExceededError");
			items.set(key, value);
		},
		removeItem: (key: string) => {
			items.delete(key);
		},
	};
};

const image = { mediaType: "image/png", base64: "aGk=".repeat(50) } as const;
const saved = {
	drafts: { s1: { text: "half a thought", images: [image] } },
	comments: { w1: [{ id: "c", path: "a.ts", side: "new", start: 1, end: 2, code: ["x", "y"], text: "rename" }] },
	failedSends: { s1: [{ text: "refused", images: [], error: "The agent is busy. Try again." }] },
} as const;

describe("keepAcrossReload", () => {
	test("hands back once what was saved before the reload", () => {
		const storage = memoryStorage();
		saveForReload(saved, storage);
		expect(takeSavedForReload(storage)).toEqual(saved);
		expect(takeSavedForReload(storage)).toBeNull();
	});

	test("keeps the text without the images when the images do not fit", () => {
		const storage = memoryStorage(400);
		saveForReload(saved, storage);
		expect(takeSavedForReload(storage)?.drafts).toEqual({ s1: { text: "half a thought", images: [] } });
	});

	test("finds nothing when nothing or something unreadable was saved", () => {
		const storage = memoryStorage();
		expect(takeSavedForReload(storage)).toBeNull();
		storage.setItem("octopus.keptAcrossReload", "{not json");
		expect(takeSavedForReload(storage)).toBeNull();
	});
});
