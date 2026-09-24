/** Notes on a change-set, anchored to a file's words, lines or whole file, or to all the changes. */
import { createContext, useContext } from "react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import { AnnotationType, type Annotation } from "@plannotator/ui/types";
import { FilledButton } from "@/components/ui/FilledButton";

export type NoteSide = "old" | "new";

export interface ChangeAnchor {
  readonly path: string;
  readonly scope: "text" | "lines" | "file";
  readonly side: NoteSide;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly charStart?: number;
  readonly charEnd?: number;
  readonly baseline: string;
}

export interface ChangeNote {
  readonly id: string;
  readonly type: AnnotationType;
  readonly text?: string;
  readonly originalText: string;
  readonly createdA: number;
  readonly anchor?: ChangeAnchor;
}

export interface Picked {
  readonly anchor: ChangeAnchor;
  readonly quote: string;
  readonly range: Range | null;
}

export interface Draft {
  readonly anchor?: ChangeAnchor;
  readonly quote: string;
  readonly target: HTMLElement;
  readonly stage: "toolbar" | "comment";
  readonly initialText?: string;
}

export interface Notes {
  readonly notes: readonly ChangeNote[];
  readonly draft: Draft | null;
  readonly selected: string | null;
  readonly baseline: string;
  readonly offer: (picked: Picked) => void;
  readonly write: (anchor: ChangeAnchor | undefined, quote: string, target: HTMLElement) => void;
  readonly select: (id: string | null) => void;
  readonly remove: (id: string) => void;
  readonly edit: (id: string, text: string) => void;
}

export const NotesContext = createContext<Notes | null>(null);

export function useNotes(): Notes | null {
  return useContext(NotesContext);
}

export function panelNote(note: ChangeNote): Annotation {
  return {
    id: note.id,
    blockId: note.anchor === undefined ? "" : `${note.anchor.side}:${note.anchor.path}`,
    startOffset: note.anchor?.lineStart ?? 0,
    endOffset: note.anchor?.lineEnd ?? 0,
    type: note.type,
    text: note.text,
    originalText: note.anchor?.scope === "file" ? "" : note.originalText,
    createdA: note.createdA,
  };
}

function lineLabel(anchor: ChangeAnchor): string {
  if (anchor.lineStart === anchor.lineEnd) return `line ${String(anchor.lineStart)}`;

  return `lines ${String(anchor.lineStart)}–${String(anchor.lineEnd)}`;
}

export function placeLabel(anchor: ChangeAnchor | undefined): string {
  if (anchor === undefined) return "All the changes";
  const name = anchor.path.slice(anchor.path.lastIndexOf("/") + 1);

  if (anchor.scope === "file") return `${name} · whole file`;

  return `${name} · ${lineLabel(anchor)}, ${anchor.side}`;
}

export interface NoteSpan {
  readonly start: number;
  readonly end: number;
  readonly id: string;
  readonly type: AnnotationType;
}

function covers(anchor: ChangeAnchor, path: string, side: NoteSide, line: number): boolean {
  return anchor.scope !== "file" && anchor.path === path && anchor.side === side && line >= anchor.lineStart && line <= anchor.lineEnd;
}

function spanOf(anchor: ChangeAnchor, line: number, length: number): [number, number] {
  if (anchor.scope !== "text") return [0, length];
  const start = line === anchor.lineStart ? anchor.charStart ?? 0 : 0;
  const end = line === anchor.lineEnd ? anchor.charEnd ?? length : length;

  return [Math.min(start, length), Math.min(end, length)];
}

export interface LineAt {
  readonly path: string;
  readonly side: NoteSide;
  readonly line: number | null;
  readonly length: number;
}

export function spansOn(notes: Notes | null, { path, side, line, length }: LineAt): NoteSpan[] {
  if (notes === null || line === null) return [];
  const spans: NoteSpan[] = [];

  for (const note of notes.notes) {
    if (note.anchor === undefined || !covers(note.anchor, path, side, line)) continue;
    const [start, end] = spanOf(note.anchor, line, length);

    spans.push({ start, end, id: note.id, type: note.type });
  }

  const draft = notes.draft;

  if (draft?.stage === "comment" && draft.anchor !== undefined && covers(draft.anchor, path, side, line)) {
    const [start, end] = spanOf(draft.anchor, line, length);

    spans.push({ start, end, id: "draft", type: AnnotationType.COMMENT });
  }

  return spans;
}

const ZERO_WIDTH = /\u200b/gu;

interface Point {
  readonly row: HTMLElement;
  readonly offset: number;
}

function rowOf(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;

  return element?.closest<HTMLElement>("[data-note-row]") ?? null;
}

function codeOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>("[data-code]");
}

function textOf(row: HTMLElement): string {
  return (codeOf(row)?.textContent ?? "").replace(ZERO_WIDTH, "");
}

function pointIn(node: Node, offset: number): Point | null {
  const row = rowOf(node);
  const code = row === null ? null : codeOf(row);

  if (row === null || code === null) return null;

  if (!code.contains(node)) return { row, offset: 0 };
  const before = document.createRange();

  before.setStart(code, 0);
  before.setEnd(node, offset);

  return { row, offset: before.toString().replace(ZERO_WIDTH, "").length };
}

function lineOf(row: HTMLElement, side: NoteSide): number | null {
  const value = row.dataset[side];

  return value === undefined ? null : Number(value);
}

function coveredRows(root: HTMLElement, range: Range, end: Point): HTMLElement[] {
  const rows = [...root.querySelectorAll<HTMLElement>("[data-note-row]")].filter((row) => range.intersectsNode(row));

  if (rows.length > 1 && rows.at(-1) === end.row && end.offset === 0) rows.pop();

  return rows;
}

interface SideChoice {
  readonly side: NoteSide;
  readonly mixed: boolean;
}

function sideOf(rows: readonly HTMLElement[]): SideChoice {
  if (rows.every((row) => row.dataset.new !== undefined)) return { side: "new", mixed: false };

  if (rows.every((row) => row.dataset.old !== undefined)) return { side: "old", mixed: false };

  return { side: rows.some((row) => row.dataset.new !== undefined) ? "new" : "old", mixed: true };
}

function quoteRows(rows: readonly HTMLElement[]): string {
  return rows.map((row) => {
    let mark = " ";

    if (row.dataset.new === undefined) mark = "-";
    else if (row.dataset.old === undefined) mark = "+";

    return `${mark} ${textOf(row)}`;
  }).join("\n");
}

export function pickSelection(root: HTMLElement, path: string, baseline: string): Picked | null {
  const selection = window.getSelection();

  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);

  if (!root.contains(range.commonAncestorContainer)) return null;
  const start = pointIn(range.startContainer, range.startOffset);
  const end = pointIn(range.endContainer, range.endOffset);

  if (start === null || end === null) return null;
  const rows = coveredRows(root, range, end);
  const { side, mixed } = sideOf(rows);
  const onSide = rows.filter((row) => lineOf(row, side) !== null);
  const first = onSide[0];
  const last = onSide.at(-1);

  if (first === undefined || last === undefined) return null;
  const charStart = first === start.row ? start.offset : 0;
  const charEnd = last === end.row ? end.offset : textOf(last).length;
  const whole = charStart === 0 && charEnd >= textOf(last).length;
  const quote = mixed ? quoteRows(rows) : range.toString().replace(ZERO_WIDTH, "").replace(/\n+$/u, "");

  if (quote.trim() === "") return null;

  const lines: ChangeAnchor = { path, side, baseline, scope: "lines", lineStart: lineOf(first, side) ?? 0, lineEnd: lineOf(last, side) ?? 0 };
  const anchor: ChangeAnchor = mixed || whole ? lines : { ...lines, scope: "text", charStart, charEnd };

  return { anchor, quote, range: range.cloneRange() };
}

export function selectLines(row: HTMLElement, from: HTMLElement | null, change: boolean): void {
  const side: NoteSide = row.dataset.new === undefined ? "old" : "new";
  const root = row.closest<HTMLElement>("[data-note-root]");
  const rows = [...(root?.querySelectorAll<HTMLElement>("[data-note-row]") ?? [])].filter((each) => lineOf(each, side) !== null);
  const at = rows.indexOf(row);
  let first = from !== null && rows.includes(from) ? Math.min(at, rows.indexOf(from)) : at;
  let last = from !== null && rows.includes(from) ? Math.max(at, rows.indexOf(from)) : at;

  if (change && row.dataset.kind !== "ctx") {
    while (first > 0 && rows[first - 1]?.dataset.kind === row.dataset.kind) first--;

    while (last < rows.length - 1 && rows[last + 1]?.dataset.kind === row.dataset.kind) last++;
  }

  const startCode = rows[first] === undefined ? null : codeOf(rows[first]);
  const endCode = rows[last] === undefined ? null : codeOf(rows[last]);

  if (startCode === null || endCode === null) return;
  const range = document.createRange();

  range.setStart(startCode, 0);
  range.setEnd(endCode, endCode.childNodes.length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

export function orderNotes(notes: readonly ChangeNote[], paths: readonly string[]): ChangeNote[] {
  const rank = (note: ChangeNote): number => (note.anchor === undefined ? paths.length : paths.indexOf(note.anchor.path));

  return [...notes].sort((a, b) => rank(a) - rank(b) || (a.anchor?.lineStart ?? 0) - (b.anchor?.lineStart ?? 0));
}

export function SendFeedback({ onSend, className = "" }: { onSend: (notes: readonly ChangeNote[]) => void; className?: string }) {
  const notes = useNotes();

  if (notes === null || notes.notes.length === 0) return null;

  return (
    <FilledButton className={`h-7 gap-1.5 px-2.5 text-xs ${className}`} onClick={() => onSend(notes.notes)} data-send-feedback>
      <PaperPlaneRightIcon size={13} weight="fill" />
      Send feedback
    </FilledButton>
  );
}
