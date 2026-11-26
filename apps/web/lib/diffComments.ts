import type { DiffFile, DiffLine } from "@repo/contracts/Git";
import { Schema } from "effect";

// One side of the diff: "old" numbers a removed line, "new" every other line.
const DiffSide = Schema.Literals(["old", "new"]);
export type DiffSide = typeof DiffSide.Type;

const LineRange = Schema.Struct({
	path: Schema.String,
	side: DiffSide,
	start: Schema.Number,
	end: Schema.Number,
});
export type LineRange = typeof LineRange.Type;

// A schema, because unsent comments are kept across a window reload.
export const DiffComment = Schema.Struct({
	...LineRange.fields,
	id: Schema.String,
	code: Schema.Array(Schema.String),
	text: Schema.String,
});
export type DiffComment = typeof DiffComment.Type;

// The side a unified line is numbered on.
export const sideOf = (line: DiffLine): DiffSide => (line.kind === "delete" ? "old" : "new");

export const numberOn = (line: DiffLine, side: DiffSide) => (side === "old" ? line.oldLine : line.newLine);

// A click picks one line. A shift-click in the same file and side stretches the pick to cover both lines.
export const pickLines = (current: LineRange | null, clicked: LineRange, extend: boolean): LineRange =>
	extend && current !== null && current.path === clicked.path && current.side === clicked.side
		? {
				...current,
				start: Math.min(current.start, clicked.start),
				end: Math.max(current.end, clicked.end),
			}
		: clicked;

export const covers = (range: LineRange, path: string, side: DiffSide, line: number | null) =>
	line !== null && range.path === path && range.side === side && line >= range.start && line <= range.end;

// The text of the picked lines, in diff order, so the agent sees what the comment is about.
export const codeIn = (file: DiffFile, range: LineRange): ReadonlyArray<string> =>
	file.content.kind !== "text"
		? []
		: file.content.hunks.flatMap((hunk) =>
				hunk.lines
					.filter((line) => line.kind !== (range.side === "old" ? "add" : "delete"))
					.filter((line) => covers(range, file.path, range.side, numberOn(line, range.side)))
					.map((line) => line.text),
			);

export const rangeLabel = ({ path, side, start, end }: LineRange) =>
	`${path}:${start === end ? start : `${start}-${end}`}${side === "old" ? " (removed)" : ""}`;

// The user's own comments as one message, each with the code it is about.
export const diffCommentsMessage = (comments: ReadonlyArray<DiffComment>) =>
	[
		"Address these comments on the changes in this workspace.",
		...comments.flatMap((comment) => [
			"",
			rangeLabel(comment),
			...comment.code.map((line) => `> ${line}`),
			comment.text.trim(),
		]),
	].join("\n");
