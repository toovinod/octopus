import { nextMode, orderedModes } from "./agentModes.ts";
import { describe, expect, test } from "bun:test";

const claude = ["ask", "acceptEdits", "plan", "auto", "fullAccess"] as const;

describe("agent modes", () => {
	test("lists an agent's modes from least to most freedom", () => {
		expect(orderedModes(claude)).toEqual(["plan", "ask", "acceptEdits", "auto", "fullAccess"]);
	});

	test("Shift+Tab steps to the next mode and wraps around", () => {
		expect(nextMode(claude, "ask")).toBe("acceptEdits");
		expect(nextMode(claude, "auto")).toBe("plan");
	});

	test("Shift+Tab never lands on full access, and leaves it for the first mode", () => {
		expect(nextMode(claude, "fullAccess")).toBe("plan");
		expect(nextMode(["auto", "readOnly", "ask", "fullAccess"], "auto")).toBe("readOnly");
	});
});
