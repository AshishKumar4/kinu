import type { ChangeBlock, ChangeRow, ChangeSpan } from "@kinu.run/core";
import type { CodeToken } from "../code-highlighter";
import type { NoteSpan } from "./notes";

export type Tint = CodeToken;

export interface Tints {
  readonly before: ReadonlyMap<number, readonly Tint[]>;
  readonly after: ReadonlyMap<number, readonly Tint[]>;
}

/** Data, not code: a CSV grammar paints every column a different colour. */
const PLAIN = new Set(["csv", "tsv", "txt", "log"]);

function rowsOf(blocks: readonly ChangeBlock[]): ChangeRow[] {
  return blocks.flatMap((block) => (block.kind === "rest" ? rowsOf(block.blocks) : [...block.rows]));
}

type Tokenize = (code: string, language: string) => Promise<Tint[][] | null>;

/** A side is tokenized as one text, so a line inside a comment keeps the comment's colour. */
async function sideOf(rows: readonly ChangeRow[], number: (row: ChangeRow) => number | null, language: string, tokenize: Tokenize) {
  const numbered = rows.flatMap((row) => {
    const at = number(row);

    return at === null ? [] : [{ at, text: row.text }];
  }).sort((a, b) => a.at - b.at);

  const tokens = await tokenize(numbered.map((line) => line.text).join("\n"), language);

  return tokens === null ? null : new Map(numbered.map((line, index) => [line.at, tokens[index] ?? []]));
}

export async function tintsOf(path: string, blocks: readonly ChangeBlock[]): Promise<Tints | null> {
  const language = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  if (PLAIN.has(language)) return null;
  const { codeTokens } = await import("../code-highlighter");
  const rows = rowsOf(blocks);

  const [before, after] = await Promise.all([
    sideOf(rows, (row) => row.oldNo, language, codeTokens),
    sideOf(rows, (row) => row.newNo, language, codeTokens),
  ]);

  return before === null || after === null ? null : { before, after };
}

export interface Piece {
  readonly text: string;
  readonly tint: Tint | null;
  readonly marked: boolean;
  readonly note: NoteSpan | null;
}

export function piecesOf(text: string, tints: readonly Tint[] | undefined, marks: readonly ChangeSpan[] = [], notes: readonly NoteSpan[] = []): Piece[] {
  const usable = tints !== undefined && tints.map((tint) => tint.text).join("") === text ? tints : [];
  const starts: number[] = [];
  const cuts = new Set<number>([0, text.length]);
  let at = 0;

  for (const tint of usable) {
    starts.push(at);
    cuts.add(at);
    at += tint.text.length;
  }

  for (const [start, end] of [...marks, ...notes.map((note) => [note.start, note.end] as const)]) {
    cuts.add(start);
    cuts.add(end);
  }

  const points = [...cuts].sort((a, b) => a - b);
  let tint = 0;

  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1] ?? text.length;

    while (tint + 1 < starts.length && (starts[tint + 1] ?? Infinity) <= start) tint++;

    return {
      text: text.slice(start, end),
      tint: usable[tint] ?? null,
      marked: marks.some(([from, to]) => start >= from && end <= to),
      note: [...notes].reverse().find((note) => start >= note.start && end <= note.end) ?? null,
    };
  }).filter((piece) => piece.text !== "");
}

export function colorOf(tint: Tint, mode: "light" | "dark"): string | undefined {
  if (mode === "dark") return tint.dark === "" ? undefined : `oklch(from ${tint.dark} l c h / 1)`;

  return tint.light === "" ? undefined : `color-mix(in oklab, ${tint.light} 72%, black)`;
}
