#!/usr/bin/env bun
// A stand-in for the codex CLI in tests. It answers `--version` and speaks a small,
// scripted slice of the app-server protocol. The user's message picks the script:
// "approve" asks for a command approval, "ask" sends a request Octopus does not support,
// anything else streams a short reply.
import codexVersion from "../generated/CODEX_VERSION" with { type: "text" };

type Answer = {
	result?: { decision?: string };
	error?: { code: number; message: string };
};

const out = Bun.stdout.writer();
const send = (message: object) => {
	out.write(`${JSON.stringify(message)}\n`);
	out.flush();
};

const threadId = "thread-new";
let turns = 0;
let turnId = "";
let interrupted = false;
let experimentalApi = false;
const waiting = new Map<number, (answer: Answer) => void>();

const notify = (method: string, params: object) => send({ method, params });

const completeTurn = (status: string, error: object | null = null) =>
	notify("turn/completed", {
		threadId,
		turn: { id: turnId, status, error, items: [] },
	});

// Failed turns, the way Codex reports them. All but "overloaded" are refused credentials.
const failures: Record<string, object> = {
	unauthorized: { message: "unexpected status 401 Unauthorized", codexErrorInfo: "unauthorized" },
	"stream 401": {
		message: "stream disconnected",
		codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 401 } },
	},
	overloaded: { message: "Codex is overloaded", codexErrorInfo: "serverOverloaded" },
	"log in": {
		message: "Your access token could not be refreshed. Please log in again.",
		codexErrorInfo: null,
	},
};

const command = {
	type: "commandExecution",
	id: "cmd-1",
	command: "bun test",
	cwd: "/repo",
	status: "inProgress",
	aggregatedOutput: null,
};

const ask = (id: number, method: string, params: object) =>
	new Promise<Answer>((resolve) => {
		waiting.set(id, resolve);
		send({ id, method, params });
	});

const runTurn = async (
	text: string,
	params: {
		model?: string;
		effort?: string | null;
		approvalPolicy?: string;
		sandboxPolicy?: { type: string };
		collaborationMode?: { mode: string; settings: object };
		input: Array<{ type: string; path?: string }>;
	},
) => {
	const failure = failures[text];
	if (failure !== undefined) return completeTurn("failed", { additionalDetails: null, ...failure });
	if (text.includes("images")) {
		notify("item/completed", {
			item: { type: "agentMessage", id: "msg-1", text: JSON.stringify(params.input.slice(1)) },
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("usage")) {
		notify("thread/tokenUsage/updated", {
			threadId,
			turnId,
			tokenUsage: {
				total: {
					totalTokens: 9000,
					inputTokens: 0,
					cachedInputTokens: 0,
					cacheWriteInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
				},
				last: {
					totalTokens: 1200,
					inputTokens: 0,
					cachedInputTokens: 0,
					cacheWriteInputTokens: 0,
					outputTokens: 0,
					reasoningOutputTokens: 0,
				},
				modelContextWindow: 272000,
			},
		});
		notify("account/rateLimits/updated", {
			rateLimits: {
				limitId: null,
				limitName: null,
				primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1700000000 },
				secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null },
				credits: null,
				planType: null,
				rateLimitReachedType: null,
			},
		});
		return completeTurn("completed");
	}
	if (text.includes("think")) {
		const reasoning = { threadId, turnId, itemId: "rs-1" };
		notify("item/started", { item: { type: "reasoning", id: "rs-1", summary: [], content: [] }, threadId, turnId });
		notify("item/reasoning/summaryPartAdded", { ...reasoning, summaryIndex: 0 });
		notify("item/reasoning/summaryTextDelta", { ...reasoning, delta: "Read the ", summaryIndex: 0 });
		notify("item/reasoning/summaryTextDelta", { ...reasoning, delta: "tests", summaryIndex: 0 });
		notify("item/reasoning/summaryPartAdded", { ...reasoning, summaryIndex: 1 });
		notify("item/reasoning/summaryTextDelta", { ...reasoning, delta: "Then run them", summaryIndex: 1 });
		notify("item/completed", {
			item: { type: "reasoning", id: "rs-1", summary: ["Read the tests", "Then run them"], content: [] },
			threadId,
			turnId,
		});
		// Reasoning with no summary has nothing to show.
		notify("item/completed", { item: { type: "reasoning", id: "rs-2", summary: [], content: [] }, threadId, turnId });
		notify("item/completed", { item: { type: "agentMessage", id: "msg-1", text: "Done" }, threadId, turnId });
		return completeTurn("completed");
	}
	if (text.includes("plan the work")) {
		// What the turn asked for, then a plan item when the turn ran in plan mode, as Codex sends it.
		notify("item/completed", {
			item: {
				type: "agentMessage",
				id: "msg-1",
				text: JSON.stringify({ experimentalApi, collaborationMode: params.collaborationMode }),
			},
			threadId,
			turnId,
		});
		if (params.collaborationMode?.mode === "plan") {
			const plan = { type: "plan", id: `plan-${turns}`, text: "" };
			notify("item/started", { item: plan, threadId, turnId });
			notify("item/plan/delta", { threadId, turnId, itemId: plan.id, delta: "1. Add tests" });
			notify("item/completed", { item: { ...plan, text: "1. Add tests\n2. Fix the bug" }, threadId, turnId });
		}
		return completeTurn(text.includes("fails") ? "failed" : "completed");
	}
	if (text.includes("policy")) {
		notify("item/completed", {
			item: {
				type: "agentMessage",
				id: "msg-1",
				text: JSON.stringify([params.approvalPolicy, params.sandboxPolicy?.type]),
			},
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("settings")) {
		notify("item/completed", {
			item: { type: "agentMessage", id: "msg-1", text: `${params.model}/${params.effort}` },
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("garbled")) {
		// What a newer or misbehaving Codex might send: a stray line, a notification and a request whose shapes
		// changed, and the null-id reply JSON-RPC gives to a line it could not parse.
		out.write("not json\n");
		notify("item/completed", { threadId, turnId, item: { id: "x" } });
		const answer = await ask(400, "item/commandExecution/requestApproval", { threadId, turnId });
		send({ id: null, error: { code: -32700, message: "Parse error" } });
		notify("item/completed", {
			item: { type: "agentMessage", id: "msg-1", text: `error ${answer.error?.code}` },
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("big diff")) {
		// A rewritten lockfile: diffs far bigger than a chat should hold.
		const change = (path: string) => ({ path, kind: { type: "update", move_path: null }, diff: "+".repeat(150_000) });
		const item = {
			type: "fileChange",
			id: "patch-1",
			changes: ["a.lock", "b.lock", "c.lock", "d.lock", "e.lock"].map(change),
			status: "completed",
		};
		notify("item/completed", { item, threadId, turnId });
		return completeTurn("completed");
	}
	if (text.includes("long command")) {
		// Octopus shows only the finished output, but each streamed chunk proves the command is alive.
		notify("item/started", { item: command, threadId, turnId });
		for (let index = 0; index < 4; index++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: "cmd-1", delta: "." });
		}
		notify("item/completed", { item: { ...command, status: "completed", aggregatedOutput: "...." }, threadId, turnId });
		return completeTurn("completed");
	}
	if (text.includes("approve")) {
		notify("item/started", { item: command, threadId, turnId });
		const answer = await ask(100, "item/commandExecution/requestApproval", {
			threadId,
			turnId,
			itemId: "cmd-1",
			command: "bun test",
			reason: "Run the tests",
		});
		const decision = answer.result?.decision;
		// A cancelled approval is followed by turn/interrupt, which ends the turn.
		if (decision === "cancel") return;
		notify("item/completed", {
			item: {
				...command,
				status: decision === "accept" ? "completed" : "declined",
				aggregatedOutput: decision === "accept" ? "3 pass" : null,
			},
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("ask me")) {
		const answer = await ask(300, "item/tool/requestUserInput", {
			threadId,
			turnId,
			itemId: "input-1",
			isBlocking: true,
			autoResolutionMs: null,
			questions: [
				{
					id: "db",
					header: "Database",
					question: "Which database?",
					isOther: true,
					isSecret: false,
					options: [{ label: "SQLite", description: "Local file" }],
				},
				{ id: "token", header: "Token", question: "Paste the token", isOther: false, isSecret: true, options: null },
			],
		});
		notify("item/completed", {
			item: { type: "agentMessage", id: "msg-1", text: JSON.stringify(answer.result) },
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	if (text.includes("elicit")) {
		const answer = await ask(200, "mcpServer/elicitation/request", {
			threadId,
			turnId,
		});
		notify("item/completed", {
			item: {
				type: "agentMessage",
				id: "msg-1",
				text: `error ${answer.error?.code}`,
			},
			threadId,
			turnId,
		});
		return completeTurn("completed");
	}
	for (const delta of ["Hel", "lo"]) {
		notify("item/agentMessage/delta", {
			threadId,
			turnId,
			itemId: "msg-1",
			delta,
		});
	}
	notify("item/completed", {
		item: { type: "agentMessage", id: "msg-1", text: "Hello" },
		threadId,
		turnId,
	});
	completeTurn("completed");
};

// Octopus must pin these, or the user's own Codex config could turn approvals off.
const hasOctopusPolicy = (params: { approvalPolicy?: string; sandbox?: string }) =>
	params.approvalPolicy === "on-request" && params.sandbox === "workspace-write";

const serve = async () => {
	for await (const line of console) {
		if (line.trim() === "") continue;
		const message = JSON.parse(line);
		if (message.method === undefined) {
			waiting.get(message.id)?.(message);
			waiting.delete(message.id);
			continue;
		}
		switch (message.method) {
			case "initialize":
				experimentalApi = message.params.capabilities?.experimentalApi === true;
				send({ id: message.id, result: { userAgent: "fake" } });
				break;
			case "account/read":
				send({
					id: message.id,
					result: {
						account: { type: "chatgpt", email: "dev@example.com" },
						requiresOpenaiAuth: true,
					},
				});
				break;
			case "account/login/start":
				send({
					id: message.id,
					result: { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example/login" },
				});
				setTimeout(
					() =>
						notify(
							"account/login/completed",
							Bun.argv[1]?.endsWith("failedLoginCodex.ts")
								? { loginId: "login-1", success: false, error: "The sign-in was cancelled." }
								: { loginId: "login-1", success: true, error: null },
						),
					50,
				);
				break;
			case "skills/list":
				send({
					id: message.id,
					result: {
						data: [
							{
								cwd: message.params.cwds[0],
								skills: [
									{ name: "tester", description: "Runs the tests", path: "/skills/tester/SKILL.md", enabled: true },
									{ name: "off", description: "Turned off", path: "/skills/off/SKILL.md", enabled: false },
								],
								errors: [],
							},
						],
					},
				});
				break;
			case "model/list":
				send({
					id: message.id,
					result: message.params.cursor
						? {
								data: [
									{
										id: "gpt-later",
										displayName: "GPT Later",
										description: "A test model",
										supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
										defaultReasoningEffort: "low",
										inputModalities: ["text"],
										isDefault: false,
									},
								],
								nextCursor: Bun.argv[1]?.endsWith("loopingModelsCodex.ts") ? "page-2" : null,
							}
						: {
								data: [
									{
										id: "gpt-first",
										displayName: "GPT First",
										description: "A test model",
										supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
										defaultReasoningEffort: "low",
										inputModalities: ["text", "image"],
										isDefault: true,
									},
								],
								nextCursor: "page-2",
							},
				});
				break;
			case "thread/start":
			case "thread/resume":
				if (!hasOctopusPolicy(message.params)) {
					send({
						id: message.id,
						error: { code: -32602, message: "approval policy not pinned" },
					});
					break;
				}
				if (message.method === "thread/start") {
					send({ id: message.id, result: { thread: { id: threadId } } });
					break;
				}
				send({
					id: message.id,
					result: { thread: { id: message.params.threadId } },
				});
				break;
			case "turn/start": {
				turnId = `turn-${++turns}`;
				interrupted = false;
				const text: string = message.params.input[0].text;
				const reply = () => send({ id: message.id, result: { turn: { id: turnId } } });
				// Never answered, like a hung app-server.
				if (text.includes("hang")) break;
				// Like an app-server that crashes.
				if (text.includes("quit now")) process.exit(1);
				if (text.includes("early")) {
					// The turn can finish before Codex answers turn/start.
					completeTurn("completed");
					reply();
					break;
				}
				if (text.includes("slow")) {
					setTimeout(reply, 200);
					setTimeout(() => interrupted || completeTurn("completed"), 400);
					break;
				}
				reply();
				void runTurn(text, message.params);
				break;
			}
			case "turn/interrupt":
				if (message.params.turnId !== turnId) {
					send({ id: message.id, error: { code: -32602, message: `no running turn ${message.params.turnId}` } });
					break;
				}
				interrupted = true;
				send({ id: message.id, result: {} });
				completeTurn("interrupted");
				break;
		}
	}
};

if (Bun.argv.includes("--version")) {
	out.write(`codex-cli ${codexVersion.trim()}\n`);
	out.flush();
} else {
	await serve();
}
