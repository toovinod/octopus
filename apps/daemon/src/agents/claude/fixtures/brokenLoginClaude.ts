#!/usr/bin/env bun
// A claude whose `auth login` fails before it shows a sign-in link.
Bun.stdout.writer().write("Error: Raw mode is not supported on the current process.stdin\r\n");
process.exit(1);
