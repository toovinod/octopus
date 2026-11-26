import { isAuthFailureText } from "./isAuthFailureText.ts";
import { describe, expect, test } from "bun:test";

describe("isAuthFailureText", () => {
	test.each([
		'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		"API Error: 401 Invalid API key · Please run /login",
		"Invalid API key · Please run /login",
		"Not logged in · Please run /login",
		"OAuth token has expired. Please obtain a new token or run /login.",
		"authentication_failed",
		"Your access token could not be refreshed. Please log in again.",
	])("reads %p as a refused credential", (text) => {
		expect(isAuthFailureText(text)).toBe(true);
	});

	test.each([
		"Fixed the handler so it returns 401 Unauthorized for expired sessions.",
		"curl: (22) The requested URL returned error: 401",
		"npm ERR! 401 Unauthorized - GET https://registry.example.com/private-pkg",
		"Hook PreToolUse:Bash failed: unauthorized access to /etc",
		"Process exited after 401 seconds",
		"Please log in to the staging dashboard to see the preview.",
		"API Error: 500 Internal server error",
		"You are not logged into any GitHub hosts. To log in, run: gh auth login",
	])("does not read %p as a refused credential", (text) => {
		expect(isAuthFailureText(text)).toBe(false);
	});
});
