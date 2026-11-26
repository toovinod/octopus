import { LocalDatabase } from "../database/LocalDatabase.ts";
import { scriptRun } from "../database/schema.ts";
import { inArray } from "drizzle-orm";
import { Effect } from "effect";

// Setup and run scripts that quitting would cut off, across every workspace. A pending run is waiting
// to retry, so it counts too.
export const countRunningScripts = Effect.fn("countRunningScripts")(function* () {
	const database = yield* LocalDatabase;
	const rows = yield* database.query((db) =>
		db
			.select({ id: scriptRun.id })
			.from(scriptRun)
			.where(inArray(scriptRun.status, ["pending", "processing"])),
	);
	return rows.length;
});
