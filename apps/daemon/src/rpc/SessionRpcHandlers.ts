import { SessionService } from "../sessions/SessionService.ts";
import { SessionRpcs } from "@repo/contracts/SessionRpcs";
import { orInternalError } from "./orInternalError.ts";
import { Effect, Redacted, Stream } from "effect";

export const SessionRpcHandlers = SessionRpcs.toLayer(
	Effect.gen(function* () {
		const sessions = yield* SessionService;
		return SessionRpcs.of({
			listAgents: () => sessions.listAgents.pipe(orInternalError("list agents")),
			setAgentApiKey: ({ agent, apiKey }) =>
				sessions.setApiKey(agent, apiKey).pipe(orInternalError("save the API key")),
			removeAgentApiKey: ({ agent }) => sessions.removeApiKey(agent).pipe(orInternalError("remove the API key")),
			createSession: (input) => sessions.create(input).pipe(orInternalError("create the chat")),
			listSessions: ({ workspaceId }) => sessions.list(workspaceId).pipe(orInternalError("list chats")),
			renameSession: ({ sessionId, title }) =>
				sessions.rename(sessionId, title).pipe(orInternalError("rename the chat")),
			sendMessage: ({ sessionId, text, images, steer }) =>
				sessions.sendMessage(sessionId, text, images, steer).pipe(orInternalError("send the message")),
			previewRevert: ({ sessionId, messageId }) =>
				sessions.previewRevert(sessionId, messageId).pipe(orInternalError("read the checkpoint")),
			revertToMessage: ({ sessionId, messageId }) =>
				sessions.revertToMessage(sessionId, messageId).pipe(orInternalError("revert the files")),
			listSessionCommands: ({ sessionId }) =>
				sessions.listCommands(sessionId).pipe(orInternalError("list the commands")),
			respondToApproval: ({ sessionId, requestId, decision }) =>
				sessions.respondToApproval(sessionId, requestId, decision).pipe(orInternalError("answer the approval")),
			respondToPlan: ({ sessionId, requestId, answer }) =>
				sessions.respondToPlan(sessionId, requestId, answer).pipe(orInternalError("answer the plan")),
			answerQuestion: ({ sessionId, requestId, answers }) =>
				sessions.answerQuestion(sessionId, requestId, answers).pipe(orInternalError("answer the questions")),
			interruptSession: ({ sessionId }) => sessions.interrupt(sessionId).pipe(orInternalError("stop the turn")),
			stopSession: ({ sessionId }) => sessions.stop(sessionId).pipe(orInternalError("stop the agent")),
			loadSessionHistory: ({ sessionId, beforeSequence, limit }) =>
				sessions.history(sessionId, beforeSequence, limit).pipe(orInternalError("load the chat")),
			subscribeSession: ({ sessionId, afterSequence }) =>
				sessions
					.subscribe(sessionId, afterSequence)
					.pipe(
						Stream.catchTag("LocalDatabaseError", (error) =>
							Stream.fromEffect(Effect.fail(error).pipe(orInternalError("load the chat"))),
						),
					),
			watchSessions: () =>
				sessions.watch.pipe(
					Stream.catchTag("LocalDatabaseError", (error) =>
						Stream.fromEffect(Effect.fail(error).pipe(orInternalError("list chats"))),
					),
				),
			setAgentAuthMode: ({ agent, mode }) =>
				sessions.setAuthMode(agent, mode).pipe(orInternalError("save the sign-in choice")),
			startAgentLogin: ({ agent }) => sessions.startLogin(agent).pipe(orInternalError("start the sign-in")),
			submitAgentLoginCode: ({ agent, code }) =>
				sessions.submitLoginCode(agent, Redacted.value(code)).pipe(orInternalError("finish the sign-in")),
			watchAgentLogins: () => sessions.watchLogins,
			updateSessionSettings: ({ sessionId, model, effort, mode }) =>
				sessions.updateSettings(sessionId, { model, effort, mode }).pipe(orInternalError("change the model")),
			getAttachment: ({ sessionId, attachmentId }) =>
				sessions.getAttachment(sessionId, attachmentId).pipe(orInternalError("load the image")),
		});
	}),
);
