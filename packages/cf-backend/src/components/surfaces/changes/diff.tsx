/** Draws a file's diff: rows, folds, word marks, syntax colours and notes. */
import { sideBySide, type ChangeBlock, type ChangeRow, type FileStatus } from "@kinu.run/core";
import { Fragment, useCallback, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { CaretDownIcon, CaretUpDownIcon } from "@phosphor-icons/react";
import { useTheme } from "@/hooks/use-theme";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { AnnotationType } from "@plannotator/ui/types";
import { colorOf, piecesOf, tintsOf, type Piece, type Tints } from "./highlight";
import { pickSelection, selectLines, spansOn, useNotes, type NoteSide, type NoteSpan } from "./notes";

const COUNT = new Intl.NumberFormat("en-US");

export function count(value: number): string {
  return COUNT.format(value);
}

const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const FULL = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function sinceLabel(at: number, now: number): string {
  const then = new Date(at).toDateString();

  if (then === new Date(now).toDateString()) return CLOCK.format(at);

  if (then === new Date(now - 864e5).toDateString()) return `yesterday, ${CLOCK.format(at)}`;

  return `${DAY.format(at)}, ${CLOCK.format(at)}`;
}

export function fullTime(at: number): string {
  return FULL.format(at);
}

const MARK_TONE: Record<FileStatus, { readonly tone: string; readonly label: string }> = {
  added: { tone: "p-success", label: "Added" },
  removed: { tone: "p-danger", label: "Deleted" },
  changed: { tone: "p-text-3", label: "Modified" },
};

export function ChangeMark({ status }: { status: FileStatus }) {
  const { tone, label } = MARK_TONE[status];

  return (
    <svg viewBox="0 0 14 14" className={`size-3.5 shrink-0 ${tone}`} role="img" aria-label={label} data-change={status}>
      <title>{label}</title>
      <rect x="1.1" y="1.1" width="11.8" height="11.8" rx="3.4" fill="none" stroke="currentColor" strokeWidth="1.25" />
      {status === "changed" ? <circle cx="7" cy="7" r="2.1" fill="currentColor" /> : <path d="M4.4 7h5.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />}
      {status === "added" && <path d="M7 4.4v5.2" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />}
    </svg>
  );
}

export function Counts({ added, removed, className = "" }: { added: number; removed: number; className?: string }) {
  if (added + removed === 0) return null;

  return (
    <span className={`shrink-0 font-mono text-[11px] tabular-nums ${className}`}>
      {added > 0 && <span className="p-success">+{count(added)}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="p-danger">−{count(removed)}</span>}
    </span>
  );
}

const ROW_TINT: Record<ChangeRow["kind"], string> = {
  add: "bg-[color-mix(in_srgb,var(--c-success)_10%,transparent)] shadow-[inset_2px_0_0_var(--c-success)]",
  del: "bg-[color-mix(in_srgb,var(--c-danger)_10%,transparent)] shadow-[inset_2px_0_0_var(--c-danger)]",
  ctx: "",
};

const WORD_TINT: Record<ChangeRow["kind"], string> = {
  add: "bg-[color-mix(in_srgb,var(--c-success)_30%,transparent)]",
  del: "bg-[color-mix(in_srgb,var(--c-danger)_30%,transparent)]",
  ctx: "",
};

const GUTTER_TONE: Record<ChangeRow["kind"], string> = {
  add: "p-success",
  del: "p-danger",
  ctx: "p-text-4",
};

const QUIET_ROW = "bg-[color-mix(in_srgb,var(--c-text)_3.5%,transparent)]";

interface Run {
  readonly marked: boolean;
  readonly note: NoteSpan | null;
  readonly pieces: Piece[];
}

function runsOf(pieces: readonly Piece[]): Run[] {
  const runs: Run[] = [];

  for (const piece of pieces) {
    const last = runs.at(-1);

    if (last !== undefined && last.marked === piece.marked && last.note?.id === piece.note?.id) last.pieces.push(piece);
    else runs.push({ marked: piece.marked, note: piece.note, pieces: [piece] });
  }

  return runs;
}

function noteClass(note: NoteSpan, selected: string | null): string {
  const kind = note.type === AnnotationType.DELETION ? "deletion" : "comment";

  return `annotation-highlight ${kind}${note.id === "draft" || note.id === selected ? " focused" : ""}`;
}

function Code({ row, tints, notes }: { row: ChangeRow; tints: Tints | null; notes: readonly NoteSpan[] }) {
  const { mode } = useTheme();
  const context = useNotes();
  const colours = row.kind === "del" ? tints?.before.get(row.oldNo ?? -1) : tints?.after.get(row.newNo ?? -1);
  const runs = runsOf(piecesOf(row.text, colours, row.marks, notes));

  return (
    <code data-code className="min-w-0 flex-1 whitespace-pre-wrap py-px pl-2.5 pr-4 [overflow-wrap:anywhere] [tab-size:2]">
      {runs.length === 0 && "\u200b"}
      {runs.map((run, index) => {
        const words = run.pieces.map((piece, at) => (
          <span key={at} style={piece.tint === null ? undefined : { color: colorOf(piece.tint, mode) }}>{piece.text}</span>
        ));

        const marked = run.marked
          ? <span className={`rounded-[3px] [box-decoration-break:clone] ${WORD_TINT[row.kind]}`}>{words}</span>
          : <>{words}</>;

        if (run.note === null) return <Fragment key={index}>{marked}</Fragment>;

        const id = run.note.id;

        return (
          <span key={index} data-note-mark={id} className={`[box-decoration-break:clone] ${noteClass(run.note, context?.selected ?? null)}`}
            onClick={id === "draft" ? undefined : () => context?.select(id)}>
            {marked}
          </span>
        );
      })}
    </code>
  );
}

function Gutter({ children, tone, width, noted = false, onPick }: {
  children?: ReactNode;
  tone: string;
  width: string;
  noted?: boolean;
  onPick?: (event: MouseEvent<HTMLSpanElement>) => void;
}) {
  const pickable = onPick === undefined ? "" : "cursor-pointer hover:p-text-2";

  return (
    <span style={{ width }} onMouseDown={onPick} onDoubleClick={onPick} data-noted={noted ? "" : undefined}
      className={`shrink-0 select-none py-px pr-1 text-right tabular-nums ${noted ? "font-semibold p-info" : tone} ${pickable}`}>
      {children}
    </span>
  );
}

interface Draw {
  readonly split: boolean;
  readonly tints: Tints | null;
  readonly gutter: string;
  readonly path: string;
  readonly onPick: ((event: MouseEvent<HTMLSpanElement>) => void) | undefined;
}

function useRowNotes(row: ChangeRow, path: string, only?: NoteSide): NoteSpan[] {
  const notes = useNotes();
  const length = row.text.length;
  const old = only === "new" || row.kind === "add" ? [] : spansOn(notes, { path, side: "old", line: row.oldNo, length });

  return only === "old" || row.kind === "del" ? old : [...old, ...spansOn(notes, { path, side: "new", line: row.newNo, length })];
}

function UnifiedRow({ row, draw }: { row: ChangeRow; draw: Draw }) {
  const notes = useRowNotes(row, draw.path);

  return (
    <div className={`flex ${ROW_TINT[row.kind]}`} data-row={row.kind} data-note-row data-kind={row.kind}
      data-old={row.oldNo ?? undefined} data-new={row.newNo ?? undefined}>
      <Gutter tone={GUTTER_TONE[row.kind]} width={draw.gutter} noted={notes.length > 0} onPick={draw.onPick}>{row.kind === "del" ? "−" : row.newNo}</Gutter>
      <Code row={row} tints={draw.tints} notes={notes} />
    </div>
  );
}

function SplitCell({ row, side, draw }: { row: ChangeRow | null; side: NoteSide; draw: Draw }) {
  const notes = useRowNotes(row ?? { kind: "ctx", text: "", oldNo: null, newNo: null }, draw.path, side);
  const edge = side === "new" ? "border-l p-border" : "";
  const confine = side === "new" ? "in-data-[picking=old]:select-none" : "in-data-[picking=new]:select-none";

  if (row === null) return <div className={`flex min-w-0 ${QUIET_ROW} ${edge}`} />;

  return (
    <div className={`flex min-w-0 ${ROW_TINT[row.kind]} ${edge} ${confine}`} data-row={row.kind} data-note-row data-kind={row.kind} data-side={side}
      data-old={side === "old" ? row.oldNo ?? undefined : undefined} data-new={side === "new" ? row.newNo ?? undefined : undefined}>
      <Gutter tone={GUTTER_TONE[row.kind]} width={draw.gutter} noted={notes.length > 0} onPick={draw.onPick}>{side === "old" ? row.oldNo : row.newNo}</Gutter>
      <Code row={row} tints={draw.tints} notes={notes} />
    </div>
  );
}

function Rows({ rows, draw }: { rows: readonly ChangeRow[]; draw: Draw }) {
  if (!draw.split) return <>{rows.map((row, index) => <UnifiedRow key={index} row={row} draw={draw} />)}</>;

  return (
    <div className="grid grid-cols-2">
      {sideBySide(rows).map((pair, index) => (
        <Fragment key={index}>
          <SplitCell row={pair.left} side="old" draw={draw} />
          <SplitCell row={pair.right} side="new" draw={draw} />
        </Fragment>
      ))}
    </div>
  );
}

function Fold({ label, context, gutter, onOpen }: { label: string; context: string | null; gutter: string; onOpen: (() => void) | null }) {
  const inner = (
    <>
      <span style={{ width: gutter }} className="flex shrink-0 justify-end pr-1 p-text-4">{onOpen !== null && <CaretUpDownIcon size={12} />}</span>
      <span className="shrink-0 pl-2.5 font-sans p-meta">{label}</span>
      {context !== null && <span className="min-w-0 truncate pr-4 text-[11px] p-text-4">{context}</span>}
    </>
  );

  const className = `flex h-7 w-full items-center gap-2 text-left ${QUIET_ROW} p-text-3`;

  if (onOpen === null) return <div className={className}>{inner}</div>;

  return <button type="button" onClick={onOpen} className={`${className} transition-colors hover:p-text`} data-diff-fold>{inner}</button>;
}

function Blocks({ blocks, draw, open, onOpen }: {
  blocks: readonly ChangeBlock[];
  draw: Draw;
  open: ReadonlySet<string>;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === "rows") return <Rows key={index} rows={block.rows} draw={draw} />;

        if (block.kind === "rest") {
          if (open.has(block.id)) return <Blocks key={index} blocks={block.blocks} draw={draw} open={open} onOpen={onOpen} />;

          return (
            <button key={index} type="button" onClick={() => onOpen(block.id)} data-diff-fold
              className={`flex h-8 w-full items-center gap-2 text-left ${QUIET_ROW} p-text-2 transition-colors hover:p-text`}>
              <span style={{ width: draw.gutter }} className="flex shrink-0 justify-end pr-1 p-text-4"><CaretDownIcon size={12} /></span>
              <span className="pl-2.5 font-sans p-meta">{block.deleted ? `Show the ${count(block.count)} deleted lines` : `Show ${count(block.count)} more lines`}</span>
            </button>
          );
        }

        if (open.has(block.id) && block.rows.length > 0) return <Rows key={index} rows={block.rows} draw={draw} />;
        const label = `${count(block.count)} unchanged ${block.count === 1 ? "line" : "lines"}`;

        return <Fold key={index} label={label} context={block.context} gutter={draw.gutter} onOpen={block.rows.length > 0 ? () => onOpen(block.id) : null} />;
      })}
    </>
  );
}

function widest(blocks: readonly ChangeBlock[]): number {
  return blocks.reduce((most, block) => {
    if (block.kind === "rest") return Math.max(most, widest(block.blocks));

    return block.rows.reduce((row, each) => Math.max(row, each.oldNo ?? 0, each.newNo ?? 0), most);
  }, 0);
}

function tintedState(status: string, tints: Tints | null): string {
  if (status === "loading") return "pending";

  return tints === null ? "plain" : "yes";
}

export function DiffBody({ path, blocks, split }: { path: string; blocks: readonly ChangeBlock[]; split: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const gutter = useMemo(() => `calc(${String(String(Math.max(widest(blocks), 99)).length)}ch + 1.4rem)`, [blocks]);
  const load = useCallback(() => tintsOf(path, blocks), [path, blocks]);
  const { resource } = useAsyncResource(load, undefined, path);
  const tints = lastValue(resource);
  const notes = useNotes();
  const root = useRef<HTMLDivElement>(null);
  const anchorRow = useRef<HTMLElement | null>(null);

  const offer = (): void => {
    const picked = notes === null || root.current === null ? null : pickSelection(root.current, path, notes.baseline);

    if (picked !== null) notes?.offer(picked);
  };

  const onPick = (event: MouseEvent<HTMLSpanElement>): void => {
    const row = event.currentTarget.closest<HTMLElement>("[data-note-row]");

    if (row === null) return;
    event.preventDefault();
    selectLines(row, event.shiftKey ? anchorRow.current : null, event.type === "dblclick");

    if (!event.shiftKey) anchorRow.current = row;
    offer();
  };

  const onMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    const side = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-side]")?.dataset.side : undefined;

    if (side !== undefined) root.current?.setAttribute("data-picking", side);
  };

  const onMouseUp = (): void => {
    root.current?.removeAttribute("data-picking");
    offer();
  };

  return (
    <div ref={root} data-note-root onMouseDown={notes === null ? undefined : onMouseDown} onMouseUp={notes === null ? undefined : onMouseUp}
      className="overflow-hidden font-mono text-[12px] leading-5 [font-variant-ligatures:none]" data-diff-tinted={tintedState(resource.status, tints)}>
      <Blocks blocks={blocks} draw={{ split, tints, gutter, path, onPick: notes === null ? undefined : onPick }} open={open}
        onOpen={(id) => setOpen((prior) => new Set([...prior, id]))} />
    </div>
  );
}
