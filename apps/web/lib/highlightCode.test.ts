import { describe, expect, test } from "bun:test";

describe("highlightCode", () => {
	// The desktop shell's CSP has no 'wasm-unsafe-eval', so highlighting must not need WebAssembly.
	test("highlights without WebAssembly", async () => {
		const wasm = globalThis.WebAssembly;
		Reflect.deleteProperty(globalThis, "WebAssembly");
		try {
			const { highlightCode } = await import("./highlightCode.ts");
			const html = await highlightCode("const answer = 42;", "ts");
			expect(html).toContain("--shiki-dark:");
			expect(html).toContain("answer");
		} finally {
			globalThis.WebAssembly = wasm;
		}
	});

	test("falls back to plain text for an unknown language", async () => {
		const { highlightCode } = await import("./highlightCode.ts");
		expect(await highlightCode("a < b", "not-a-language")).toContain("a &#x3C; b");
	});
});
