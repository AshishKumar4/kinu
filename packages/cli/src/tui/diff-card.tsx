/**
 * The file-edit diff card. Rebuilds the diff from the call's recorded spans or written file with the same LCS
 * (`vfs/diff.ts`) as the change-set; an overwrite's prior contents are gone, so `replaced` says "diff unavailable".
 */
import * as v from 'valibot';

import {
  diffLines, MAX_LINES_PER_FILE, parseJsonValue, TUI_MARKS,
  type DiffLine, type FileStatus,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';

import { clipText } from '@kinu.run/core';
import { useTuiTheme } from './theme';

/** The expanded tool-result line budget, shared with the card. */
export const EXPANDED_RESULT_LINES = 20;

const EditResultSchema = v.object({
  ok: v.literal(true),
  path: v.string(),
  // A landed edit always reports a span, so empty means another tool's payload.
  applied: v.pipe(v.array(v.object({ line: v.number(), removed_lines: v.number(), added_lines: v.number() })), v.minLength(1)),
});

const WriteResultSchema = v.object({
  ok: v.literal(true),
  path: v.string(),
  action: v.picklist(['created', 'replaced']),
  bytes: v.optional(v.number()),
});

const EditCallSchema = v.object({
  action: v.literal('edit'),
  path: v.string(),
  edits: v.array(v.object({ old_text: v.string(), new_text: v.string() })),
});

const WriteCallSchema = v.object({
  action: v.literal('write'),
  path: v.string(),
  content: v.string(),
});

/** `hunks === null` renders "diff unavailable". */
export interface FileEditDiffView {
  readonly path: string;
  readonly status: FileStatus;
  readonly hunks: readonly (readonly DiffLine[])[] | null;
  readonly counts: { readonly added: number; readonly removed: number } | null;
  readonly label?: string;
  /** The read model ran out of body room upstream; the counts still hold. */
  readonly truncated: boolean;
}

const DIFF_PREFIX: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: ' ', hunk: ' ' };

function fileWriteResult(content: string):
  | { readonly kind: 'edit'; readonly body: v.InferOutput<typeof EditResultSchema> }
  | { readonly kind: 'write'; readonly body: v.InferOutput<typeof WriteResultSchema> }
  | null {
  const parsed = tolerate(() => parseJsonValue(content), 'malformed-input');

  if (parsed === undefined) return null;
  const edit = v.safeParse(EditResultSchema, parsed);

  if (edit.success) return { kind: 'edit', body: edit.output };

  const write = v.safeParse(WriteResultSchema, parsed);

  return write.success ? { kind: 'write', body: write.output } : null;
}

/** Tool and path must agree: transcript order is not a call identity. */
function fileWriteCall(argsText: string | undefined, path: string):
  | { readonly kind: 'edit'; readonly args: v.InferOutput<typeof EditCallSchema> }
  | { readonly kind: 'write'; readonly args: v.InferOutput<typeof WriteCallSchema> }
  | null {
  if (argsText === undefined) return null;
  const parsed = tolerate(() => parseJsonValue(argsText), 'malformed-input');

  if (parsed === undefined) return null;

  const edit = v.safeParse(EditCallSchema, parsed);

  if (edit.success && edit.output.path === path) return { kind: 'edit', args: edit.output };

  const write = v.safeParse(WriteCallSchema, parsed);

  return write.success && write.output.path === path ? { kind: 'write', args: write.output } : null;
}

/** Context included: the model's anchoring lines orient the change. */
function editHunks(edits: readonly { readonly old_text: string; readonly new_text: string }[]): Pick<FileEditDiffView, 'hunks' | 'truncated'> {
  const hunks: DiffLine[][] = [];
  let carried = 0;
  let truncated = false;

  for (const edit of edits) {
    const diff = diffLines(toLf(edit.old_text), toLf(edit.new_text));
    const room = MAX_LINES_PER_FILE - carried;

    if (room <= 0) {
      truncated = true;
      break;
    }

    if (diff.lines.length > room) truncated = true;
    hunks.push(diff.lines.slice(0, room));
    carried += Math.min(diff.lines.length, room);

    if (truncated) break;
  }

  return { hunks, truncated };
}

export function fileEditDiffView(
  call: { readonly toolName?: string; readonly args?: string } | undefined,
  result: { readonly toolName?: string; readonly content: string; readonly success?: boolean },
): FileEditDiffView | null {
  if (result.success === false) return null;

  const toolName = result.toolName ?? call?.toolName;

  if (toolName !== undefined && toolName !== 'file') return null;

  const body = fileWriteResult(result.content);

  if (body === null) return null;

  const { path } = body.body;
  const recorded = call === undefined ? null : fileWriteCall(call.args, path);

  if (body.kind === 'edit') {
    const counts = { added: 0, removed: 0 };

    for (const span of body.body.applied) {
      counts.added += span.added_lines;
      counts.removed += span.removed_lines;
    }

    // Call row absent or unreadable: keep the result's true counts.
    if (recorded?.kind !== 'edit') {
      return { path, status: 'changed', hunks: null, counts, truncated: false, label: 'edited' };
    }

    return { path, status: 'changed', counts, ...editHunks(recorded.args.edits) };
  }

  if (body.body.action === 'created' && recorded?.kind === 'write') {
    const diff = diffLines('', toLf(recorded.args.content));

    return {
      path, status: 'added', hunks: [diff.lines],
      counts: { added: diff.added, removed: diff.removed },
      truncated: diff.truncated === true, label: 'new file',
    };
  }

  return {
    path,
    status: body.body.action === 'created' ? 'added' : 'changed',
    hunks: null,
    counts: null,
    truncated: false,
    label: writeLabel(body.body.action === 'created', body.body.bytes),
  };
}

/** The tool LF-normalizes its text; align the same form so a CRLF anchor is not a whole-file change. */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Bounded by the shared line budget, so a large write cannot flood the transcript. */
function writeLabel(created: boolean, bytes: number | undefined): string {
  if (created) return 'new file';

  return bytes === undefined ? 'replaced' : `replaced · ${String(bytes)} B`;
}

function diffTrailer(omitted: number, truncated: boolean): string | null {
  if (omitted > 0) {
    return `+${String(omitted)} more line${omitted === 1 ? '' : 's'}${truncated ? ' · truncated' : ''}`;
  }

  return truncated ? `… diff ends at ${String(MAX_LINES_PER_FILE)} lines. The totals cover the full file.` : null;
}

export function FileDiffCard({ view, expanded, previewWidth, lineCap = EXPANDED_RESULT_LINES }: {
  readonly view: FileEditDiffView;
  readonly expanded: boolean;
  readonly previewWidth: number;
  readonly lineCap?: number;
}) {
  const { well } = useTuiTheme().colors;
  const inkFor = { add: well.success, del: well.danger, ctx: well.muted, hunk: well.muted } as const;
  const hunks = view.hunks ?? [];
  const shown = expanded ? hunks : hunks.slice(0, 1);
  const totalLines = hunks.reduce((sum, hunk) => sum + hunk.length, 0);
  const rows: Array<DiffLine | 'gap'> = [];
  let drawn = 0;

  for (const hunk of shown) {
    const room = Math.min(hunk.length, lineCap - drawn);

    if (hunk.length === 0) continue;

    if (room <= 0) break;

    if (rows.length > 0) rows.push('gap');

    rows.push(...hunk.slice(0, room));
    drawn += room;

    if (room < hunk.length) break;
  }

  const omitted = totalLines - drawn;

  const trailer = diffTrailer(omitted, view.truncated);

  return (
    <box flexDirection="column" style={{ paddingLeft: 2 }}>
      <text>
        <span fg={well.muted}>{`${TUI_MARKS.toolResult} `}</span>
        <span fg={well.ink}>{view.path}</span>
        {view.counts === null || view.counts.added === 0 ? null : <span fg={well.success}>{` +${String(view.counts.added)}`}</span>}
        {view.counts === null || view.counts.removed === 0 ? null : <span fg={well.danger}>{` −${String(view.counts.removed)}`}</span>}
        {view.label === undefined ? null : <span fg={well.muted}>{` · ${view.label}`}</span>}
      </text>
      {view.hunks === null && <text><span fg={well.muted}>  diff unavailable</span></text>}
      {view.hunks !== null && totalLines === 0 && (
        <text><span fg={well.muted}>{view.status === 'added' ? '  empty file' : '  no visible changes'}</span></text>
      )}
      {rows.map((row, index) => row === 'gap' ? (
        <text key={`gap-${String(index)}`}><span fg={well.muted}>{'  ⋮'}</span></text>
      ) : (
        <text key={`line-${String(index)}`}>
          <span fg={inkFor[row.kind]}>{`  ${DIFF_PREFIX[row.kind]} `}</span>
          <span fg={inkFor[row.kind]}>{clipText(row.text, previewWidth)}</span>
        </text>
      ))}
      {trailer === null ? null : <text><span fg={well.muted}>{`  ${trailer}`}</span></text>}
    </box>
  );
}
