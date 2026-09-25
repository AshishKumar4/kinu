/**
 * A change-set as the Changes tab reads it: rows numbered, unchanged runs folded, a paired line's changed words
 * marked, long files previewed, files as a tree in reading order. Pure, so every client draws the same diff.
 */
import { vfsBasename, vfsDirname } from '../utils/vfs-helpers';
import { diffLines, type DiffLine, type FileDiff } from '../vfs/diff';
import type { DiffAnchor } from '../types/plans';

export interface ChangeSet {
  readonly source: string;
  readonly label: string;
  readonly mode: 'vfs-baseline' | 'git';
  readonly files: readonly FileDiff[];
  readonly trackedSince?: number;
  readonly baseline?: string;
  /** A git view's repositories, as the folders their files are listed under. */
  readonly repositories?: readonly string[];
  readonly error?: string;
}

export type ChangeSpan = readonly [number, number];

export interface ChangeRow {
  readonly kind: Exclude<DiffLine['kind'], 'hunk'>;
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly marks?: readonly ChangeSpan[];
}

export type ChangeBlock =
  | { readonly kind: 'rows'; readonly rows: readonly ChangeRow[] }
  | { readonly kind: 'gap'; readonly id: string; readonly rows: readonly ChangeRow[]; readonly count: number; readonly context: string | null }
  | { readonly kind: 'rest'; readonly id: string; readonly blocks: readonly ChangeBlock[]; readonly count: number; readonly deleted: boolean };

export type ChangeBody =
  | { readonly kind: 'rows' | 'empty' | 'binary' | 'uncompared' | 'counted' }
  | { readonly kind: 'capped'; readonly hidden: number };

export interface ChangePair {
  readonly left: ChangeRow | null;
  readonly right: ChangeRow | null;
}

export type ChangeTreeRow =
  | { readonly kind: 'folder'; readonly name: string; readonly path: string; readonly depth: number; readonly repository: boolean }
  | { readonly kind: 'file'; readonly file: FileDiff; readonly depth: number };

const CONTEXT = 3;

const MIN_FOLD = 4;

const PREVIEW = {
  alone: { whole: 60, long: 200, changed: 120 },
  stacked: { whole: 30, long: 90, changed: 60 },
} as const;

const MARK_MAX = 400;

const MARK_KEPT = 0.4;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/u;

const TOKEN = /\w+|\s+|[^\w\s]/gu;

export function changeBody(file: FileDiff): ChangeBody {
  if (file.omitted === 'binary') return { kind: 'binary' };

  if (file.omitted === 'large') return { kind: 'uncompared' };

  if (file.truncated !== true) return { kind: file.lines.length === 0 ? 'empty' : 'rows' };

  if (file.lines.length === 0) return { kind: 'counted' };
  const shown = file.lines.filter((line) => line.kind === 'add' || line.kind === 'del').length;

  return { kind: 'capped', hidden: Math.max(0, file.added + file.removed - shown) };
}

interface Hunk {
  readonly newStart: number;
  readonly context: string | null;
}

type Item = { readonly kind: 'row'; readonly row: ChangeRow } | { readonly kind: 'hunk'; readonly hunk: Hunk };

function numbered(file: FileDiff): Item[] {
  const items: Item[] = [];
  let oldNo = 1;
  let newNo = 1;

  for (const line of file.lines) {
    if (line.kind === 'hunk') {
      const hunk = HUNK.exec(line.text);

      if (hunk !== null) {
        oldNo = Number(hunk[1]);
        newNo = Number(hunk[2]);
        items.push({ kind: 'hunk', hunk: { newStart: newNo, context: hunk[3]?.trim() || null } });
      }

      continue;
    }

    if (line.kind === 'add') items.push({ kind: 'row', row: { kind: 'add', text: line.text, oldNo: null, newNo: newNo++ } });
    else if (line.kind === 'del') items.push({ kind: 'row', row: { kind: 'del', text: line.text, oldNo: oldNo++, newNo: null } });
    else items.push({ kind: 'row', row: { kind: 'ctx', text: line.text, oldNo: oldNo++, newNo: newNo++ } });
  }

  return items;
}

function solid(text: string): number {
  return text.replace(/\s/gu, '').length;
}

function extend(spans: [number, number][], text: string, start: number, end: number): void {
  const last = spans.at(-1);

  if (last !== undefined && text.slice(last[1], start).trim() === '') last[1] = end;
  else if (text.slice(start, end).trim() !== '') spans.push([start, end]);
}

function trimmed(text: string, [start, end]: readonly [number, number]): ChangeSpan {
  const inner = text.slice(start, end);
  const lead = inner.length - inner.trimStart().length;

  return [start + lead, start + lead + inner.trim().length];
}

/** Null when most of the line was rewritten: marking every word says nothing. */
function wordMarks(before: string, after: string): [ChangeSpan[], ChangeSpan[]] | null {
  if (before.length > MARK_MAX || after.length > MARK_MAX) return null;
  const aligned = diffLines((before.match(TOKEN) ?? []).join('\n'), (after.match(TOKEN) ?? []).join('\n'));

  if (aligned.truncated === true) return null;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  let at = 0;
  let to = 0;
  let kept = 0;

  for (const piece of aligned.lines) {
    if (piece.kind === 'ctx') {
      kept += solid(piece.text);
      at += piece.text.length;
      to += piece.text.length;
    } else if (piece.kind === 'del') {
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

function withMarks(rows: readonly ChangeRow[]): ChangeRow[] {
  const out = [...rows];
  const dels = out.flatMap((row, index) => (row.kind === 'del' ? [index] : []));
  const adds = out.flatMap((row, index) => (row.kind === 'add' ? [index] : []));

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

function foldRun(run: readonly ChangeRow[], afterChange: boolean, beforeChange: boolean, id: string): ChangeBlock[] {
  const head = afterChange ? CONTEXT : 0;
  const tail = beforeChange ? CONTEXT : 0;

  if (run.length - head - tail < MIN_FOLD) return [{ kind: 'rows', rows: run }];
  const hidden = run.slice(head, run.length - tail);

  return [
    { kind: 'rows', rows: run.slice(0, head) },
    { kind: 'gap', id, rows: hidden, count: hidden.length, context: null },
    { kind: 'rows', rows: run.slice(run.length - tail) },
  ];
}

function merged(blocks: readonly ChangeBlock[]): ChangeBlock[] {
  const out: ChangeBlock[] = [];

  for (const block of blocks) {
    const last = out.at(-1);

    if (block.kind === 'rows' && block.rows.length === 0) continue;

    if (block.kind === 'rows' && last?.kind === 'rows') out[out.length - 1] = { kind: 'rows', rows: [...last.rows, ...block.rows] };
    else out.push(block);
  }

  return out;
}

function changed(file: FileDiff, items: readonly Item[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let run: ChangeRow[] = [];
  let change: ChangeRow[] = [];
  let seen = false;
  let lastNew = 0;

  const endChange = (): void => {
    if (change.length > 0) blocks.push({ kind: 'rows', rows: withMarks(change) });
    change = [];
  };

  const endRun = (beforeChange: boolean): void => {
    if (run.length > 0) blocks.push(...foldRun(run, seen, beforeChange, `${file.path}:${String(run[0]?.newNo ?? 0)}`));
    run = [];
  };

  for (const item of items) {
    if (item.kind === 'hunk') {
      endChange();
      endRun(false);
      const skipped = item.hunk.newStart - lastNew - 1;

      if (skipped > 0) blocks.push({ kind: 'gap', id: `${file.path}:@${String(item.hunk.newStart)}`, rows: [], count: skipped, context: item.hunk.context });
      lastNew = item.hunk.newStart - 1;
      seen = false;
      continue;
    }

    lastNew = item.row.newNo ?? lastNew;

    if (item.row.kind === 'ctx') {
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

function shownRows(blocks: readonly ChangeBlock[]): number {
  return blocks.reduce((sum, block) => sum + (block.kind === 'rows' ? block.rows.length : 0), 0);
}

function linesIn(blocks: readonly ChangeBlock[]): number {
  return blocks.reduce((sum, block) => sum + (block.kind === 'rows' ? block.rows.length : block.count), 0);
}

function preview(blocks: readonly ChangeBlock[], limit: number, id: string): ChangeBlock[] {
  const out: ChangeBlock[] = [];
  let shown = 0;

  for (const [index, block] of blocks.entries()) {
    if (block.kind !== 'rows' || shown + block.rows.length <= limit) {
      out.push(block);
      shown += block.kind === 'rows' ? block.rows.length : 0;
      continue;
    }

    const rest: ChangeBlock[] = [{ kind: 'rows', rows: block.rows.slice(limit - shown) }, ...blocks.slice(index + 1)];

    out.push({ kind: 'rows', rows: block.rows.slice(0, limit - shown) }, { kind: 'rest', id, blocks: rest, count: linesIn(rest), deleted: false });

    return merged(out);
  }

  return out;
}

/** `stacked`: shorter previews; a deleted file folded. */
export function changeBlocks(file: FileDiff, stacked = false): ChangeBlock[] {
  const items = numbered(file);
  const limits = stacked ? PREVIEW.stacked : PREVIEW.alone;

  if (file.status !== 'changed') {
    const rows: ChangeBlock[] = [{ kind: 'rows', rows: items.flatMap((item) => (item.kind === 'row' ? [item.row] : [])) }];

    if (stacked && file.status === 'removed') return [{ kind: 'rest', id: `${file.path}:deleted`, blocks: rows, count: shownRows(rows), deleted: true }];

    return shownRows(rows) > limits.whole + MIN_FOLD ? preview(rows, limits.whole, `${file.path}:rest`) : rows;
  }

  const blocks = changed(file, items);

  return shownRows(blocks) > limits.long ? preview(blocks, limits.changed, `${file.path}:rest`) : blocks;
}

/** Split view: each change's removed rows beside its added rows, and an unchanged row beside itself. */
export function sideBySide(rows: readonly ChangeRow[]): ChangePair[] {
  const out: ChangePair[] = [];
  let dels: ChangeRow[] = [];
  let adds: ChangeRow[] = [];

  const flush = (): void => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at++) out.push({ left: dels[at] ?? null, right: adds[at] ?? null });
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.kind === 'ctx') {
      flush();
      out.push({ left: row, right: row });
    } else if (row.kind === 'del') {
      if (adds.length > 0) flush();
      dels.push(row);
    } else {
      adds.push(row);
    }
  }

  flush();

  return out;
}

interface Folder {
  readonly folders: Map<string, Folder>;
  readonly files: FileDiff[];
}

function folderIn(parent: Folder, name: string): Folder {
  const known = parent.folders.get(name);

  if (known !== undefined) return known;
  const made: Folder = { folders: new Map(), files: [] };
  parent.folders.set(name, made);

  return made;
}

/** `within`: the folder's path, '' at the root. A repository's folder is never joined with the folder it holds. */
function rowsOf(folder: Folder, depth: number, within: string, repositories: ReadonlySet<string>): ChangeTreeRow[] {
  const rows: ChangeTreeRow[] = [];
  const at = (label: string): string => (within === '' ? label : `${within}/${label}`);

  for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
    let label = name;
    let inner = child;

    while (!repositories.has(at(label)) && inner.files.length === 0 && inner.folders.size === 1) {
      const [[next, only]] = [...inner.folders];
      label = `${label}/${next}`;
      inner = only;
    }

    const path = at(label);

    rows.push({ kind: 'folder', name: label, path, depth, repository: repositories.has(path) }, ...rowsOf(inner, depth + 1, path, repositories));
  }

  const files = [...folder.files].sort((a, b) => vfsBasename(a.path).localeCompare(vfsBasename(b.path)));

  return [...rows, ...files.map((file) => ({ kind: 'file', file, depth }) as const)];
}

/** Folders before files at each level; a folder holding only one folder is one row ("packages/checkout"). */
export function changeTree(files: readonly FileDiff[], repositories: readonly string[] = []): ChangeTreeRow[] {
  const root: Folder = { folders: new Map(), files: [] };

  for (const file of files) {
    const parts = vfsDirname(file.path).split('/').filter((part) => part !== '');
    parts.reduce(folderIn, root).files.push(file);
  }

  return rowsOf(root, 0, '', new Set(repositories));
}

function sameFile(a: FileDiff, b: FileDiff): boolean {
  return a.status === b.status && a.added === b.added && a.removed === b.removed && a.truncated === b.truncated
    && a.omitted === b.omitted && a.lines.length === b.lines.length
    && a.lines.every((line, index) => line.kind === b.lines[index]?.kind && line.text === b.lines[index]?.text);
}

/** A poll's files, each unchanged one kept as `previous`'s object, so its blocks and tokens are not redone. */
export function keepUnchanged(previous: readonly FileDiff[], next: readonly FileDiff[]): FileDiff[] {
  const held = new Map(previous.map((file) => [file.path, file]));

  return next.map((file) => {
    const before = held.get(file.path);

    return before !== undefined && sameFile(before, file) ? before : file;
  });
}

export function comparePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');

  for (let at = 0; at < Math.min(left.length, right.length); at++) {
    const leftFolder = at < left.length - 1;
    const rightFolder = at < right.length - 1;

    if (left[at] === right[at] && leftFolder && rightFolder) continue;

    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;

    return (left[at] ?? '').localeCompare(right[at] ?? '');
  }

  return left.length - right.length;
}

/** What a note on `anchor` quotes; null when a line is outside the diff's hunks. */
export function anchoredText(file: FileDiff, anchor: DiffAnchor): string | null {
  if (anchor.scope === 'file') return '';
  const byLine = new Map<number, string>();

  for (const item of numbered(file)) {
    if (item.kind !== 'row') continue;
    const at = anchor.side === 'old' ? item.row.oldNo : item.row.newNo;

    if (at !== null) byLine.set(at, item.row.text);
  }

  const texts: string[] = [];

  for (let line = anchor.lineStart; line <= anchor.lineEnd; line++) {
    const text = byLine.get(line);

    if (text === undefined) return null;
    texts.push(text);
  }

  if (anchor.scope === 'text') {
    texts[texts.length - 1] = (texts.at(-1) ?? '').slice(0, anchor.charEnd);
    texts[0] = (texts[0] ?? '').slice(anchor.charStart);
  }

  return texts.join('\n');
}

export function inReadingOrder(files: readonly FileDiff[]): FileDiff[] {
  return changeTree(files).flatMap((row) => (row.kind === 'file' ? [row.file] : []));
}

export function changeTotals(files: readonly FileDiff[]): { readonly added: number; readonly removed: number } {
  return files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
}
