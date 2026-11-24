#!/usr/bin/env bun
// Stands in for the user's `claude`. `auth login` behaves like the real one on a terminal: it
// prints the sign-in link as an OSC 8 hyperlink, then waits for a pasted code.
const out = Bun.stdout.writer();
const [command, subcommand] = Bun.argv.slice(2);

if (command === "auth" && subcommand === "login") {
	const url = "https://claude.ai/oauth/authorize?code=true&client_id=test&state=abc";
	out.write("Opening browser to sign in…\r\n");
	out.write(`If the browser didn't open, visit:\r\n\x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n`);
	out.write("Paste code here if prompted > ");
	out.flush();
	for await (const line of console) {
		const success = line.trim() === "good-code";
		out.write(success ? "Login successful.\r\n" : "Invalid code\r\n");
		out.flush();
		process.exit(success ? 0 : 1);
	}
} else {
	// Reports an API key login when one is in its environment, as the real CLI does.
	const apiKey = Bun.env.ANTHROPIC_API_KEY !== undefined;
	out.write(
		`${JSON.stringify({ loggedIn: true, authMethod: apiKey ? "api_key" : "claude.ai", email: apiKey ? null : "dev@example.com" })}\n`,
	);
	out.flush();
}
