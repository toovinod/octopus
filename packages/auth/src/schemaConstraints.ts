import type { BetterAuthPlugin } from "better-auth";

// Constraints Better Auth's own tables leave out. `bun run generate:schema` merges them into the tables it writes.
export const schemaConstraints = () =>
	({
		id: "octopus-schema-constraints",
		schema: {
			// Accepting two invitations, or an accept racing a direct add, could make a user a member twice.
			member: { fields: {}, indexes: [{ fields: ["organizationId", "userId"], unique: true }] },
			// Better Auth looks an identity up by provider and provider account id, and two rows would
			// make sign-in pick one user or the other.
			account: { fields: {}, indexes: [{ fields: ["providerId", "accountId"], unique: true }] },
		},
	}) satisfies BetterAuthPlugin;
