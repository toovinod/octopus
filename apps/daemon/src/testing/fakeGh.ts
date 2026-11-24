import { Effect, FileSystem } from "effect";
import { join } from "node:path";

// A stand-in gh that answers from a script, so tests never reach GitHub. Each call's arguments go to gh.log.
export const fakeGh = Effect.fn("fakeGh")(function* (tempDir: string, body: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = join(tempDir, "gh");
	yield* fs.writeFileString(path, `#!/bin/sh\necho "$@" >> "${tempDir}/gh.log"\n${body}\n`);
	yield* fs.chmod(path, 0o755);
	return path;
});
