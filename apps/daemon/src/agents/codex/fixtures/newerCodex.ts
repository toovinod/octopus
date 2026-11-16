#!/usr/bin/env bun
// A codex CLI newer than the generated protocol types that still speaks the same protocol.
if (Bun.argv.includes("--version")) {
	Bun.stdout.writer().write("codex-cli 0.999.0\n");
} else {
	await import("./fakeCodex.ts");
}
