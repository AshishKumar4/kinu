/** A change-set as the Changes panel reads it: rows numbered, unchanged lines folded, changed words marked, drawn. */
import { diffLines, type FileDiff, type FileStatus } from "@kinu.run/core";
import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { CaretDownIcon, CaretUpDownIcon } from "@phosphor-icons/react";
import { useTheme } from "@/hooks/use-theme";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { colorOf, piecesOf, tintsOf, type Tints } from "./highlight";

export type Omitted = "binary" | "large";

export interface ChangedFile extends FileDiff {
  readonly omitted?: Omitted;
}

export interface ChangeSet {
  readonly source: string;
  readonly label: string;
  readonly mode: "vfs-baseline" | "git";
  readonly files: readonly ChangedFile[];
  readonly trackedSince?: number;
  readonly error?: string;
}

export type RowKind = "add" | "del" | "ctx";

export type Span = readonly [number, number];

export interface Row {
  readonly kind: RowKind;
  readonly text: string;
  
  readonly oldNo: number | null;
  
  readonly newNo: number | null;
  
  readonly marks?: readonly Span[];
}

export type Block =
  | { readonly kind: "rows"; readonly rows: readonly Row[] }
  
  | { readonly kind: "gap"; readonly id: string; readonly rows: readonly Row[]; readonly count: number; readonly context: string | null }
  
  | { readonly kind: "rest"; readonly id: string; readonly blocks: readonly Block[]; readonly count: number; readonly deleted: boolean };

export type Body =
  | { readonly kind: "rows" }
  | { readonly kind: "binary" }
  
  | { readonly kind: "unread"; readonly why: Omitted | null }
  
  | { readonly kind: "large" }
  
  | { readonly kind: "capped"; readonly hidden: number };

const CONTEXT = 3;

const MIN_FOLD = 4;

const PREVIEW = {
  alone: { whole: 60, long: 200, changed: 120 },
  stacked: { whole: 30, long: 90, changed: 60 },
} as const;

const MARK_MAX = 400;

const MARK_KEPT = 0.4;

const BINARY_ROW = "(binary file differs)";

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/u;

const TOKEN = /\w+|\s+|[^\w\s]/gu;

export function bodyOf(file: ChangedFile): Body {
  if (file.omitted === "binary" || (file.lines.length === 1 && file.lines[0]?.text === BINARY_ROW)) return { kind: "binary" };

  if (file.lines.length === 0 && file.truncated === true) {
    return file.omitted === "large" || file.added + file.removed === 0 ? { kind: "unread", why: file.omitted ?? null } : { kind: "large" };
  }

  if (file.truncated === true) {
    const shown = file.lines.filter((line) => line.kind !== "ctx").length;

    return { kind: "capped", hidden: Math.max(0, file.added + file.removed - shown) };
  }

  return { kind: "rows" };
}

interface Hunk {
  readonly newStart: number;
  readonly context: string | null;
}

type Item = { readonly kind: "row"; readonly row: Row } | { readonly kind: "hunk"; readonly hunk: Hunk };

function numbered(file: FileDiff, git: boolean): Item[] {
  const items: Item[] = [];
  let oldNo = 1;
  let newNo = 1;

  for (const line of file.lines) {
    const hunk = git && line.kind === "ctx" ? HUNK.exec(line.text) : null;

    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      items.push({ kind: "hunk", hunk: { newStart: newNo, context: hunk[3]?.trim() || null } });
      continue;
    }

    if (line.kind === "add") items.push({ kind: "row", row: { kind: "add", text: line.text, oldNo: null, newNo: newNo++ } });
    else if (line.kind === "del") items.push({ kind: "row", row: { kind: "del", text: line.text, oldNo: oldNo++, newNo: null } });
    else items.push({ kind: "row", row: { kind: "ctx", text: line.text, oldNo: oldNo++, newNo: newNo++ } });
  }

  return items;
}

function solid(text: string): number {
  return text.replace(/\s/gu, "").length;
}

function extend(spans: [number, number][], text: string, start: number, end: number): void {
  const last = spans.at(-1);

  if (last !== undefined && text.slice(last[1], start).trim() === "") last[1] = end;
  else if (text.slice(start, end).trim() !== "") spans.push([start, end]);
}

function trimmed(text: string, [start, end]: readonly [number, number]): Span {
  const inner = text.slice(start, end);
  const lead = inner.length - inner.trimStart().length;

  return [start + lead, start + lead + inner.trim().length];
}

/** Core's line diff run over words; null when most of the line was rewritten, since marking every word says nothing. */
function wordMarks(before: string, after: string): [Span[], Span[]] | null {
  if (before.length > MARK_MAX || after.length > MARK_MAX) return null;
  const aligned = diffLines((before.match(TOKEN) ?? []).join("\n"), (after.match(TOKEN) ?? []).join("\n"));

  if (aligned.truncated === true) return null;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  let at = 0;
  let to = 0;
  let kept = 0;

  for (const piece of aligned.lines) {
    if (piece.kind === "ctx") {
      kept += solid(piece.text);
      at += piece.text.length;
      to += piece.text.length;
    } else if (piece.kind === "del") {
      extend(left, before, at, at + piece.text.length);
      at += piece.text.length;
    } else {
      extend(right, after, to, to + piece.text.length);
      to += piece.text.length;
    }
  }

  const size = Math.max(solid(before), solid(after));

  if (size === 0 || kept / size < MARK_KEPT) return null;

  return [left.map((span) => trimmed(before, span)), right.map((span) => trimmed(after, span))];
}

function withMarks(rows: readonly Row[]): Row[] {
  const out = [...rows];
  const dels = out.flatMap((row, index) => (row.kind === "del" ? [index] : []));
  const adds = out.flatMap((row, index) => (row.kind === "add" ? [index] : []));

  for (let pair = 0; pair < Math.min(dels.length, adds.length); pair++) {
    const del = out[dels[pair] ?? -1];
    const add = out[adds[pair] ?? -1];
    const marks = del === undefined || add === undefined ? null : wordMarks(del.text, add.text);

    if (del === undefined || add === undefined || marks === null) continue;
    out[dels[pair] ?? -1] = { ...del, marks: marks[0] };
    out[adds[pair] ?? -1] = { ...add, marks: marks[1] };
  }

  return out;
}

function foldRun(run: readonly Row[], afterChange: boolean, beforeChange: boolean, id: string): Block[] {
  const head = afterChange ? CONTEXT : 0;
  const tail = beforeChange ? CONTEXT : 0;

  if (run.length - head - tail < MIN_FOLD) return [{ kind: "rows", rows: run }];
  const hidden = run.slice(head, run.length - tail);

  return [
    { kind: "rows", rows: run.slice(0, head) },
    { kind: "gap", id, rows: hidden, count: hidden.length, context: null },
    { kind: "rows", rows: run.slice(run.length - tail) },
  ];
}

function merged(blocks: readonly Block[]): Block[] {
  const out: Block[] = [];

  for (const block of blocks) {
    const last = out.at(-1);

    if (block.kind === "rows" && block.rows.length === 0) continue;

    if (block.kind === "rows" && last?.kind === "rows") out[out.length - 1] = { kind: "rows", rows: [...last.rows, ...block.rows] };
    else out.push(block);
  }

  return out;
}

function changed(file: FileDiff, items: readonly Item[]): Block[] {
  const blocks: Block[] = [];
  let run: Row[] = [];
  let change: Row[] = [];
  let seen = false;
  let lastNew = 0;

  const endChange = (): void => {
    if (change.length > 0) blocks.push({ kind: "rows", rows: withMarks(change) });
    change = [];
  };

  const endRun = (beforeChange: boolean): void => {
    if (run.length > 0) blocks.push(...foldRun(run, seen, beforeChange, `${file.path}:${String(run[0]?.newNo ?? 0)}`));
    run = [];
  };

  for (const item of items) {
    if (item.kind === "hunk") {
      endChange();
      endRun(false);
      const skipped = item.hunk.newStart - lastNew - 1;

      if (skipped > 0) blocks.push({ kind: "gap", id: `${file.path}:@${String(item.hunk.newStart)}`, rows: [], count: skipped, context: item.hunk.context });
      lastNew = item.hunk.newStart - 1;
      seen = false;
      continue;
    }

    lastNew = item.row.newNo ?? lastNew;

    if (item.row.kind === "ctx") {
      endChange();
      run.push(item.row);
      continue;
    }

    endRun(true);
    seen = true;
    change.push(item.row);
  }

  endChange();
  endRun(false);

  return merged(blocks);
}

function shownRows(blocks: readonly Block[]): number {
  return blocks.reduce((sum, block) => sum + (block.kind === "rows" ? block.rows.length : 0), 0);
}

function linesIn(blocks: readonly Block[]): number {
  return blocks.reduce((sum, block) => sum + (block.kind === "rows" ? block.rows.length : block.count), 0);
}

function preview(blocks: readonly Block[], limit: number, id: string): Block[] {
  const out: Block[] = [];
  let shown = 0;

  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "rows" || shown + block.rows.length <= limit) {
      out.push(block);
      shown += block.kind === "rows" ? block.rows.length : 0;
      continue;
    }

    const rest: Block[] = [{ kind: "rows", rows: block.rows.slice(limit - shown) }, ...blocks.slice(index + 1)];

    out.push({ kind: "rows", rows: block.rows.slice(0, limit - shown) }, { kind: "rest", id, blocks: rest, count: linesIn(rest), deleted: false });

    return merged(out);
  }

  return out;
}

export function blocksOf(file: FileDiff, git: boolean, stacked = false): Block[] {
  const items = numbered(file, git);
  const limits = stacked ? PREVIEW.stacked : PREVIEW.alone;

  if (file.status !== "changed") {
    const rows: Block[] = [{ kind: "rows", rows: items.flatMap((item) => (item.kind === "row" ? [item.row] : [])) }];

    if (stacked && file.status === "removed") return [{ kind: "rest", id: `${file.path}:deleted`, blocks: rows, count: shownRows(rows), deleted: true }];

    return shownRows(rows) > limits.whole + MIN_FOLD ? preview(rows, limits.whole, `${file.path}:rest`) : rows;
  }

  const blocks = changed(file, items);

  return shownRows(blocks) > limits.long ? preview(blocks, limits.changed, `${file.path}:rest`) : blocks;
}

export interface Pair {
  readonly left: Row | null;
  readonly right: Row | null;
}

function sideBySide(rows: readonly Row[]): Pair[] {
  const out: Pair[] = [];
  let dels: Row[] = [];
  let adds: Row[] = [];

  const flush = (): void => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at++) out.push({ left: dels[at] ?? null, right: adds[at] ?? null });
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.kind === "ctx") {
      flush();
      out.push({ left: row, right: row });
    } else if (row.kind === "del") {
      if (adds.length > 0) flush();
      dels.push(row);
    } else {
      adds.push(row);
    }
  }

  flush();

  return out;
}

export function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");

  return cut < 0 ? "" : path.slice(0, cut);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export type TreeRow =
  | { readonly kind: "folder"; readonly name: string; readonly depth: number }
  | { readonly kind: "file"; readonly file: ChangedFile; readonly depth: number };

interface Folder {
  readonly folders: Map<string, Folder>;
  readonly files: ChangedFile[];
}

function folderIn(parent: Folder, name: string): Folder {
  const known = parent.folders.get(name);

  if (known !== undefined) return known;
  const made: Folder = { folders: new Map(), files: [] };
  parent.folders.set(name, made);

  return made;
}

function rowsOf(folder: Folder, depth: number): TreeRow[] {
  const rows: TreeRow[] = [];

  for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
    let label = name;
    let inner = child;

    while (inner.files.length === 0 && inner.folders.size === 1) {
      const [[next, only]] = [...inner.folders];
      label = `${label}/${next}`;
      inner = only;
    }

    rows.push({ kind: "folder", name: label, depth }, ...rowsOf(inner, depth + 1));
  }

  const files = [...folder.files].sort((a, b) => nameOf(a.path).localeCompare(nameOf(b.path)));

  return [...rows, ...files.map((file) => ({ kind: "file", file, depth }) as const)];
}

export function treeOf(files: readonly ChangedFile[]): TreeRow[] {
  const root: Folder = { folders: new Map(), files: [] };

  for (const file of files) {
    const parts = folderOf(file.path).split("/").filter((part) => part !== "");
    parts.reduce(folderIn, root).files.push(file);
  }

  return rowsOf(root, 0);
}

export function reading(files: readonly ChangedFile[]): ChangedFile[] {
  return treeOf(files).flatMap((row) => (row.kind === "file" ? [row.file] : []));
}

export function totals(files: readonly ChangedFile[]): { readonly added: number; readonly removed: number } {
  return files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
}

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

const ROW_TINT: Record<Row["kind"], string> = {
  add: "bg-[color-mix(in_srgb,var(--c-success)_10%,transparent)] shadow-[inset_2px_0_0_var(--c-success)]",
  del: "bg-[color-mix(in_srgb,var(--c-danger)_10%,transparent)] shadow-[inset_2px_0_0_var(--c-danger)]",
  ctx: "",
};

const WORD_TINT: Record<Row["kind"], string> = {
  add: "bg-[color-mix(in_srgb,var(--c-success)_30%,transparent)]",
  del: "bg-[color-mix(in_srgb,var(--c-danger)_30%,transparent)]",
  ctx: "",
};

const GUTTER_TONE: Record<Row["kind"], string> = {
  add: "p-success",
  del: "p-danger",
  ctx: "p-text-4",
};

const QUIET_ROW = "bg-[color-mix(in_srgb,var(--c-text)_3.5%,transparent)]";

function Code({ row, tints }: { row: Row; tints: Tints | null }) {
  const { mode } = useTheme();
  const colours = row.kind === "del" ? tints?.before.get(row.oldNo ?? -1) : tints?.after.get(row.newNo ?? -1);
  const pieces = piecesOf(row.text, colours, row.marks);
  const runs: { marked: boolean; pieces: typeof pieces }[] = [];

  for (const piece of pieces) {
    const last = runs.at(-1);

    if (last !== undefined && last.marked === piece.marked) last.pieces.push(piece);
    else runs.push({ marked: piece.marked, pieces: [piece] });
  }

  return (
    <code className="min-w-0 flex-1 whitespace-pre-wrap py-px pl-2.5 pr-4 [overflow-wrap:anywhere] [tab-size:2]">
      {runs.length === 0 && "\u200b"}
      {runs.map((run, index) => {
        const words = run.pieces.map((piece, at) => (
          <span key={at} style={piece.tint === null ? undefined : { color: colorOf(piece.tint, mode) }}>{piece.text}</span>
        ));

        return run.marked
          ? <span key={index} className={`rounded-[3px] [box-decoration-break:clone] ${WORD_TINT[row.kind]}`}>{words}</span>
          : <Fragment key={index}>{words}</Fragment>;
      })}
    </code>
  );
}

function Gutter({ children, tone, width }: { children?: ReactNode; tone: string; width: string }) {
  return <span style={{ width }} className={`shrink-0 select-none py-px pr-1 text-right tabular-nums ${tone}`}>{children}</span>;
}

interface Draw {
  readonly split: boolean;
  readonly tints: Tints | null;
  readonly gutter: string;
}

function UnifiedRow({ row, draw }: { row: Row; draw: Draw }) {
  return (
    <div className={`flex ${ROW_TINT[row.kind]}`} data-row={row.kind}>
      <Gutter tone={GUTTER_TONE[row.kind]} width={draw.gutter}>{row.kind === "del" ? "−" : row.newNo}</Gutter>
      <Code row={row} tints={draw.tints} />
    </div>
  );
}

function SplitCell({ row, side, draw }: { row: Row | null; side: "old" | "new"; draw: Draw }) {
  const edge = side === "new" ? "border-l p-border" : "";

  if (row === null) return <div className={`flex min-w-0 ${QUIET_ROW} ${edge}`} />;

  return (
    <div className={`flex min-w-0 ${ROW_TINT[row.kind]} ${edge}`} data-row={row.kind}>
      <Gutter tone={GUTTER_TONE[row.kind]} width={draw.gutter}>{side === "old" ? row.oldNo : row.newNo}</Gutter>
      <Code row={row} tints={draw.tints} />
    </div>
  );
}

function Rows({ rows, draw }: { rows: readonly Row[]; draw: Draw }) {
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
  blocks: readonly Block[];
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

function widest(blocks: readonly Block[]): number {
  return blocks.reduce((most, block) => {
    if (block.kind === "rest") return Math.max(most, widest(block.blocks));

    return block.rows.reduce((row, each) => Math.max(row, each.oldNo ?? 0, each.newNo ?? 0), most);
  }, 0);
}

function tintedState(status: string, tints: Tints | null): string {
  if (status === "loading") return "pending";

  return tints === null ? "plain" : "yes";
}

export function DiffBody({ path, blocks, split }: { path: string; blocks: readonly Block[]; split: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const gutter = useMemo(() => `calc(${String(String(Math.max(widest(blocks), 99)).length)}ch + 1.4rem)`, [blocks]);
  const load = useCallback(() => tintsOf(path, blocks), [path, blocks]);
  const { resource } = useAsyncResource(load, undefined, path);
  const tints = lastValue(resource);

  return (
    <div className="overflow-hidden font-mono text-[12px] leading-5 [font-variant-ligatures:none]" data-diff-tinted={tintedState(resource.status, tints)}>
      <Blocks blocks={blocks} draw={{ split, tints, gutter }} open={open} onOpen={(id) => setOpen((prior) => new Set([...prior, id]))} />
    </div>
  );
}
