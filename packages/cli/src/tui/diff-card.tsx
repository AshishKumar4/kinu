/**
 * The file-edit diff card — the transcript's one diff view.
 *
 * A `file` call's `edit`/`write` result carries what the model needs — the
 * path, the counts, never a diff (tools/file-edit.ts is explicit about not
 * echoing one back into context). This card reconstructs the diff for the
 * HUMAN from what the call itself recorded: the spans it asked replaced, or
 * the whole file it wrote, aligned by the same LCS (`vfs/diff.ts`) the
 * workspace change-set runs, so a transcript hunk and a Diffs surface hunk
 * can never disagree about what one algorithm calls a change.
 *
 * What it cannot know it says in words: an overwrite's earlier contents are
 * gone by the time the result arrives — the turn ledger keeps digests, not
 * bodies — so a `replaced` write gets the card's header and
 * "diff unavailable" rather than an empty box or a guessed reconstruction.
 */
import * as v from 'valibot';

import {
  diffLines, MAX_LINES_PER_FILE, parseJsonValue, TUI_MARKS,
  type DiffLine, type FileStatus,
} from '@kinu.run/core';
import { tolerate } from '@kinu.run/core/obs';

import { clipText } from '@kinu.run/core';
import { useTuiTheme } from './theme';

/** The line budget an expanded tool result already answers to; the diff card
 *  spends it the same way and says so in a trailer rather than overrunning. */
export const EXPANDED_RESULT_LINES = 20;

const EditResultSchema = v.object({
  ok: v.literal(true),
  path: v.string(),
  // A landed edit always reports at least one span — `no_change` is refused
  // earlier — so an empty array here belongs to some other tool's payload.
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

/** What the card draws: the path, the true +/- counts when they are known,
 *  and the hunks when a diff could be reconstructed at all. `hunks === null`
 *  is the stated absence — "diff unavailable" — never an empty card. */
export interface FileEditDiffView {
  readonly path: string;
  readonly status: FileStatus;
  readonly hunks: readonly (readonly DiffLine[])[] | null;
  readonly counts: { readonly added: number; readonly removed: number } | null;
  /** A qualifier after the path: "new file", "replaced", "edited". */
  readonly label?: string;
  /** The read model ran out of body room upstream; the counts still hold. */
  readonly truncated: boolean;
}

const DIFF_PREFIX: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: ' ' };

/** A successful file edit/write result, or null — a refusal or another
 *  action's payload keeps the ordinary text row. */
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

/** The recorded call for a result, when it is this tool and this file. A call
 *  paired positionally still has to agree on the path — transcript order is
 *  not a call identity. */
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

/**
 * One hunk per requested span: each edit's own `diffLines` output — context
 * included, because the model writes the anchoring lines into old_text and
 * they are exactly what orients the change — capped at what the read model
 * itself would carry for one file.
 */
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

/**
 * The card model for one `file` result row. `call` is the transcript row the
 * result was paired with (by toolCallId when it carries one); its args hold
 * the before/after the tool recorded. Anything that is not a successful file
 * edit/write answer — a refusal, `list`/`stat`/`search`, another tool's
 * payload — returns null and keeps its text row.
 */
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

    // The call row is absent or unreadable: the result still recorded the
    // true line counts, so the header stays honest and the body says so.
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
    label: body.body.action === 'created'
      ? 'new file'
      : body.body.bytes === undefined ? 'replaced' : `replaced · ${String(body.body.bytes)} B`,
  };
}

/** The tool's own text is LF-normalized before it ever meets a file; the card
 *  aligns the same form so a CRLF anchor cannot read as a whole-file change. */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * The card: `↳ path +N −M`, then prefixed hunk lines in the well's own
 * success/danger inks — the same tokens the failure counts already draw with,
 * so the contrast audit that holds the well's inks already holds these.
 * Collapsed shows the first hunk; expanded shows every hunk, both bounded by
 * the shared result-line budget with a "+K more lines" trailer, so creating a
 * large file cannot flood the transcript.
 */
export function FileDiffCard({ view, expanded, previewWidth, lineCap = EXPANDED_RESULT_LINES }: {
  readonly view: FileEditDiffView;
  readonly expanded: boolean;
  readonly previewWidth: number;
  readonly lineCap?: number;
}) {
  const { well } = useTuiTheme().colors;
  const inkFor = { add: well.success, del: well.danger, ctx: well.muted } as const;
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

  const trailer = omitted > 0
    ? `+${String(omitted)} more line${omitted === 1 ? '' : 's'}${view.truncated ? ' · truncated' : ''}`
    : view.truncated
      ? `… diff ends at ${String(MAX_LINES_PER_FILE)} lines. The totals cover the full file.`
      : null;

  return (
    <box flexDirection="column" style={{ paddingLeft: 2 }}>
      <text>
        <span fg={well.muted}>{`${TUI_MARKS.toolResult} `}</span>
        <span fg={well.ink}>{view.path}</span>
        {view.counts === null || view.counts.added === 0 ? null : <span fg={well.success}>{` +${String(view.counts.added)}`}</span>}
        {view.counts === null || view.counts.removed === 0 ? null : <span fg={well.danger}>{` −${String(view.counts.removed)}`}</span>}
        {view.label === undefined ? null : <span fg={well.muted}>{` · ${view.label}`}</span>}
      </text>
      {view.hunks === null ? (
        <text><span fg={well.muted}>  diff unavailable</span></text>
      ) : totalLines === 0 ? (
        <text><span fg={well.muted}>{view.status === 'added' ? '  empty file' : '  no visible changes'}</span></text>
      ) : null}
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
