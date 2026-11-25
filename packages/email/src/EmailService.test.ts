import { EmailSendError, EmailService, EmailServiceTest, SentEmails, retryRetryableSends } from "./EmailService.ts";
import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

// Fails with the given errors in turn, then succeeds, and counts its attempts.
const sendFailingWith = (...errors: ReadonlyArray<EmailSendError>) =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0);
		const send = Effect.gen(function* () {
			const attempt = yield* Ref.getAndUpdate(attempts, (count) => count + 1);
			const error = errors[attempt];
			if (error !== undefined) {
				return yield* error;
			}
		});
		const fiber = yield* Effect.forkChild(Effect.result(retryRetryableSends(send)));
		yield* TestClock.adjust("1 minute");
		return { result: (yield* Fiber.join(fiber))._tag, attempts: yield* Ref.get(attempts) };
	}).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);

const sendError = (retryable: boolean) => new EmailSendError({ message: "failed", retryable, cause: null });

describe("retryRetryableSends", () => {
	test("sends again after a retryable failure", async () => {
		expect(await sendFailingWith(sendError(true), sendError(true))).toEqual({ result: "Success", attempts: 3 });
	});

	test("does not send again after a permanent failure", async () => {
		expect(await sendFailingWith(sendError(false))).toEqual({ result: "Failure", attempts: 1 });
	});

	test("gives up after four retries", async () => {
		const errors = Array.from({ length: 10 }, () => sendError(true));
		expect(await sendFailingWith(...errors)).toEqual({ result: "Failure", attempts: 5 });
	});
});

describe("EmailService", () => {
	test("the test layer records invitation emails instead of sending them", async () => {
		const sent = await Effect.gen(function* () {
			const email = yield* EmailService;
			yield* email.sendInvitation({
				to: "ada@example.com",
				organizationName: "Acme",
				inviterName: "Grace",
				acceptUrl: "https://octopus.test/invite/abc",
				idempotencyKey: "invitation/abc",
			});
			return yield* Ref.get(yield* SentEmails);
		}).pipe(Effect.provide(EmailServiceTest), Effect.runPromise);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe("ada@example.com");
		expect(sent[0]?.subject).toBe("Join Acme on Octopus");
		expect(sent[0]?.text).toContain("Grace invited you to join Acme");
		expect(sent[0]?.text).toContain("https://octopus.test/invite/abc");
	});
});
