import { type MembershipEvent, MembershipEvents } from "./MembershipEvents.ts";
import { membershipHooks, sessionHooks } from "./membershipHooks.ts";
import { describe, expect, test } from "bun:test";
import { Effect, PubSub } from "effect";

// Better Auth's own types require Date fields.
const epoch = new Date(0);
const organization = {
	id: "org_1",
	name: "Acme",
	slug: "acme",
	createdAt: epoch,
};
const user = {
	id: "user_1",
	name: "Ada",
	email: "ada@example.com",
	emailVerified: true,
	createdAt: epoch,
	updatedAt: epoch,
};
const member = {
	id: "member_1",
	organizationId: organization.id,
	userId: user.id,
	role: "admin",
	createdAt: epoch,
};
const invitation = {
	id: "invitation_1",
	organizationId: organization.id,
	email: "grace@example.com",
	role: "member",
	status: "canceled" as const,
	inviterId: user.id,
	expiresAt: epoch,
	createdAt: epoch,
};

const publishedWith = <Hooks>(
	makeHooks: (publish: (event: MembershipEvent) => Promise<void>) => Hooks,
	callHook: (hooks: Hooks) => Promise<void>,
) =>
	Effect.gen(function* () {
		const events = yield* MembershipEvents;
		const subscription = yield* events.subscribe;
		const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
		yield* Effect.promise(() => callHook(makeHooks((event) => runPromise(events.publish(event)))));
		return yield* PubSub.take(subscription);
	}).pipe(Effect.scoped, Effect.provide(MembershipEvents.layer), Effect.runPromise);

const publishedBy = (callHook: (hooks: ReturnType<typeof membershipHooks>) => Promise<void>) =>
	publishedWith(membershipHooks, callHook);

describe("membershipHooks", () => {
	test("publishes memberRemoved after a member is removed", async () => {
		const event = await publishedBy((hooks) => hooks.afterRemoveMember({ member, user, organization }));
		expect(event).toEqual({
			_tag: "memberRemoved",
			organizationId: "org_1",
			userId: "user_1",
		});
	});

	test("publishes memberRoleChanged with the old and new role", async () => {
		const event = await publishedBy((hooks) =>
			hooks.afterUpdateMemberRole({
				member,
				previousRole: "member",
				user,
				organization,
			}),
		);
		expect(event).toEqual({
			_tag: "memberRoleChanged",
			organizationId: "org_1",
			userId: "user_1",
			previousRole: "member",
			role: "admin",
		});
	});

	test("publishes invitationRevoked after an invitation is cancelled", async () => {
		const event = await publishedBy((hooks) =>
			hooks.afterCancelInvitation({
				invitation,
				cancelledBy: user,
				organization,
			}),
		);
		expect(event).toEqual({
			_tag: "invitationRevoked",
			organizationId: "org_1",
			invitationId: "invitation_1",
		});
	});

	test("publishes organizationDeleted after an org is deleted", async () => {
		const event = await publishedBy((hooks) => hooks.afterDeleteOrganization({ organization, user }));
		expect(event).toEqual({
			_tag: "organizationDeleted",
			organizationId: "org_1",
		});
	});

	test("publishes sessionRevoked after Better Auth deletes a session", async () => {
		const session = {
			id: "session_1",
			userId: user.id,
			token: "token",
			expiresAt: epoch,
			createdAt: epoch,
			updatedAt: epoch,
		};
		const event = await publishedWith(sessionHooks, (hooks) => hooks.session.delete.after(session));
		expect(event).toEqual({ _tag: "sessionRevoked", userId: "user_1", sessionId: "session_1" });
	});
});
