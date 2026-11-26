// Entry point for the Better Auth CLI (`bun run generate:schema`). The CLI only reads the
// plugin list to generate tables, so no real secrets or database are needed here. The CLI loads this
// file through jiti, which cannot import Bun built-ins, so the database is a pg-proxy that never connects.

import { authRelations } from "@repo/db-cloud/authSchema";
import { drizzle } from "drizzle-orm/pg-proxy";
import { createAuth } from "./createAuth.ts";
import { Redacted } from "effect";

const placeholder = Redacted.make("schema-generation-only");
const oauthClient = {
	clientId: "schema-generation-only",
	clientSecret: placeholder,
};

export const auth = createAuth({
	config: {
		baseUrl: "http://localhost",
		webOrigin: "http://localhost",
		secret: placeholder,
		databaseUrl: placeholder,
		github: oauthClient,
		google: oauthClient,
	},
	database: drizzle(() => Promise.reject(new Error("schema generation only")), { relations: authRelations }),
	sendInvitation: () => Promise.resolve(),
	publishMembershipEvent: () => Promise.resolve(),
});
