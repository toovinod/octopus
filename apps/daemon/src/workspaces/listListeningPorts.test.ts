import { parseLsofPorts, parseSsPorts } from "./listListeningPorts.ts";
import { describe, expect, test } from "bun:test";

describe("parseLsofPorts", () => {
	test("reads each port once, from IPv4, IPv6 and wildcard addresses", () => {
		const output = ["p4242", "f20", "n*:3000", "f21", "n[::1]:5173", "p4243", "f9", "n127.0.0.1:3000", ""].join("\n");
		expect(parseLsofPorts(output)).toEqual([3000, 5173]);
	});

	test("finds nothing in empty output", () => {
		expect(parseLsofPorts("")).toEqual([]);
	});
});

describe("parseSsPorts", () => {
	const output = [
		'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=42,fd=20))',
		'LISTEN 0      511             [::]:3000          [::]:*    users:(("node",pid=42,fd=21))',
		'LISTEN 0      128        127.0.0.1:5432       0.0.0.0:*    users:(("postgres",pid=7,fd=5))',
		'LISTEN 0      4096       127.0.0.1:8080       0.0.0.0:*    users:(("sh",pid=40,fd=3),("vite",pid=43,fd=3))',
		"LISTEN 0      4096       127.0.0.1:631        0.0.0.0:*",
	].join("\n");

	test("keeps only the ports of the given processes", () => {
		expect(parseSsPorts(output, new Set([42, 43]))).toEqual([3000, 8080]);
	});

	test("finds nothing for processes that listen on nothing", () => {
		expect(parseSsPorts(output, new Set([99]))).toEqual([]);
	});
});
