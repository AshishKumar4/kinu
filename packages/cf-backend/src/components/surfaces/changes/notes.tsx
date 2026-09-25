/** Notes on a change-set, anchored to a file's words, lines or whole file, or to all the changes. */
import { createContext, useContext } from "react";
import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import type { Annotation } from "@plannotator/ui/types";
import type { DiffAnchor, DiffSide, ReviewAnnotation } from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";
import { annotationType } from "../annotation-type";

export interface Picked {
  readonly anchor: DiffAnchor;
  readonly range: Range | null;
}

export interface Draft {
  readonly anchor?: DiffAnchor;
  readonly quote: string;
  readonly target: HTMLElement;
  readonly stage: "toolbar" | "comment";
  readonly initialText?: string;
}

export interface Notes {
  readonly notes: readonly ReviewAnnotation[];
  readonly moved: ReadonlySet<string>;
  readonly draft: Draft | null;
  readonly selected: string | null;
  readonly baseline: string;
  readonly failure: string | null;
  readonly sending: boolean;
  readonly offer: (picked: Picked) => void;
  readonly write: (anchor: DiffAnchor | undefined, quote: string, target: HTMLElement) => void;
  readonly select: (id: string | null) => void;
  readonly remove: (id: string) => void;
  readonly edit: (id: string, text: string) => void;
  readonly send: () => void;
}

export const NotesContext = createContext<Notes | null>(null);

export function useNotes(): Notes | null {
  return useContext(NotesContext);
}

export function panelNote(note: ReviewAnnotation): Annotation {
  return {
    id: note.id,
    blockId: note.blockId,
    startOffset: note.startOffset,
    endOffset: note.endOffset,
    type: annotationType(note.type),
    text: note.text,
    originalText: note.anchor?.scope === "file" ? "" : note.originalText,
    createdA: note.createdA,
  };
}

function lineLabel(anchor: Exclude<DiffAnchor, { readonly scope: "file" }>): string {
  if (anchor.lineStart === anchor.lineEnd) return `line ${String(anchor.lineStart)}`;

  return `lines ${String(anchor.lineStart)}–${String(anchor.lineEnd)}`;
}

export function placeLabel(anchor: DiffAnchor | undefined): string {
  if (anchor === undefined) return "All the changes";
  const name = anchor.path.slice(anchor.path.lastIndexOf("/") + 1);

  if (anchor.scope === "file") return `${name} · whole file`;

  return `${name} · ${lineLabel(anchor)}, ${anchor.side}`;
}

export interface NoteSpan {
  readonly start: number;
  readonly end: number;
  readonly id: string;
  readonly type: ReviewAnnotation["type"];
}

function covers(anchor: DiffAnchor, path: string, side: DiffSide, line: number): boolean {
  return anchor.scope !== "file" && anchor.path === path && anchor.side === side && line >= anchor.lineStart && line <= anchor.lineEnd;
}

function spanOf(anchor: DiffAnchor, line: number, length: number): [number, number] {
  if (anchor.scope !== "text") return [0, length];
  const start = line === anchor.lineStart ? anchor.charStart : 0;
  const end = line === anchor.lineEnd ? anchor.charEnd : length;

  return [Math.min(start, length), Math.min(end, length)];
}

export interface LineAt {
  readonly path: string;
  readonly side: DiffSide;
  readonly line: number | null;
  readonly length: number;
}

export function spansOn(notes: Notes | null, { path, side, line, length }: LineAt): NoteSpan[] {
  if (notes === null || line === null) return [];
  const spans: NoteSpan[] = [];

  for (const note of notes.notes) {
    if (note.anchor === undefined || notes.moved.has(note.id) || !covers(note.anchor, path, side, line)) continue;
    const [start, end] = spanOf(note.anchor, line, length);

    spans.push({ start, end, id: note.id, type: note.type });
  }

  const draft = notes.draft;

  if (draft?.stage === "comment" && draft.anchor !== undefined && covers(draft.anchor, path, side, line)) {
    const [start, end] = spanOf(draft.anchor, line, length);

    spans.push({ start, end, id: "draft", type: "COMMENT" });
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

function lineOf(row: HTMLElement, side: DiffSide): number | null {
  const value = row.dataset[side];

  return value === undefined ? null : Number(value);
}

function coveredRows(root: HTMLElement, range: Range, end: Point): HTMLElement[] {
  const rows = [...root.querySelectorAll<HTMLElement>("[data-note-row]")].filter((row) => range.intersectsNode(row));

  if (rows.length > 1 && rows.at(-1) === end.row && end.offset === 0) rows.pop();

  return rows;
}

interface SideChoice {
  readonly side: DiffSide;
  readonly mixed: boolean;
}

function sideOf(rows: readonly HTMLElement[]): SideChoice {
  if (rows.every((row) => row.dataset.new !== undefined)) return { side: "new", mixed: false };

  if (rows.every((row) => row.dataset.old !== undefined)) return { side: "old", mixed: false };

  return { side: rows.some((row) => row.dataset.new !== undefined) ? "new" : "old", mixed: true };
}

export function pickSelection(root: HTMLElement, path: string, baseline: string): Picked | null {
  const selection = window.getSelection();

  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed || selection.toString().trim() === "") return null;
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
  const lineStart = lineOf(first, side) ?? 0;
  const lineEnd = lineOf(last, side) ?? 0;

  const anchor: DiffAnchor = mixed || whole
    ? { scope: "lines", path, side, lineStart, lineEnd, baseline }
    : { scope: "text", path, side, lineStart, lineEnd, charStart, charEnd, baseline };

  return { anchor, range: range.cloneRange() };
}

export function selectLines(row: HTMLElement, from: HTMLElement | null, change: boolean): void {
  const side: DiffSide = row.dataset.new === undefined ? "old" : "new";
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

export function NotesFailure() {
  const notes = useNotes();

  if (notes?.failure == null) return null;

  return <p role="alert" className="min-w-0 truncate p-meta p-danger" data-notes-failure title={notes.failure}>{notes.failure}</p>;
}

export function SendFeedback({ className = "" }: { className?: string }) {
  const notes = useNotes();

  if (notes === null || notes.notes.length === 0) return null;

  return (
    <FilledButton className={`h-7 gap-1.5 px-2.5 text-xs ${className}`} onClick={notes.send} disabled={notes.sending} data-send-feedback>
      <PaperPlaneRightIcon size={13} weight="fill" />
      Send feedback
    </FilledButton>
  );
}
