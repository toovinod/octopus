import { MAX_IMAGE_BASE64_LENGTH } from "@repo/contracts/AgentSession";
import { describe, expect, spyOn, test } from "bun:test";
import { readImages } from "./images.ts";

describe("readImages", () => {
	test("refuses a file over the limit without reading it", async () => {
		const read = spyOn(globalThis, "FileReader");
		const big = new File([new Uint8Array((MAX_IMAGE_BASE64_LENGTH / 4) * 3 + 3)], "big.png", { type: "image/png" });
		const { images, problems } = await readImages([big], 4);
		expect(images).toEqual([]);
		expect(problems).toEqual(["big.png is larger than 5 MB."]);
		expect(read).not.toHaveBeenCalled();
		read.mockRestore();
	});
});
