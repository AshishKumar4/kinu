/**
 * The compaction archive manifest — the checkpoint's navigation index.
 *
 * The ladder already archives every compacted range verbatim at a citable VFS
 * path (stores.ts), and the checkpoint message already names the newest one.
 * That makes the archive readable but not *navigable*: the model can grep, it
 * cannot glance. The manifest closes that gap — one mechanical line per
 * archived range (turn span, role mix, the ask that opened it, the file that
 * holds it), rendered with no LLM in the path and appended to the very message
 * the checkpoint rides on.
 *
 * Ranges are non-overlapping by construction. A compaction always archives the
 * conversation prefix `[0, boundary)`, so each successive archive is a superset
 * of the last; the manifest indexes what each one ADDED and cites the smallest
 * archive containing it. Continuation is proven, not assumed: an indexed range's
 * `rangeHash` IS the content hash of the prefix it ended, so re-hashing that many
 * turns of the new prefix either reproduces it — and the delta is everything
 * after — or the history was rewritten underneath and the index restarts.
 */

import { rangeHash, type Turn } from '@better-compact/core';

/** One archived range: the slice of conversation a single compaction folded
 *  out, plus the smallest archive file that contains it. */
export interface ArchiveRange {
  /** Content hash of the whole compacted prefix ending at `endTurn` — the
   *  archive file's identity AND the proof the next range continues it. */
  rangeHash: string;
  /** Citable VFS path of the archive holding this range. */
  path: string;
  /** 1-based turn ordinals within the session's durable history. */
  startTurn: number;
  endTurn: number;
  userTurns: number;
  assistantTurns: number;
  /** First user ask inside the range, one line, bounded. */
  firstUserAsk: string;
}

/** Durable index of a session's archived ranges. Append-only within one
 *  history; cleared wholesale when that history is rewritten. */
export interface ArchiveIndexStore {
  /** Ranges oldest-first. */
  list(sessionKey: string): ArchiveRange[];
  /** Append a range; a repeat of the same `rangeHash` is a no-op. */
  append(sessionKey: string, range: ArchiveRange): void;
  /** Drop the index — the history it described no longer exists. */
  clear(sessionKey: string): void;
}

const ASK_SNIPPET_CHARS = 120;
/** Newest ranges kept in the rendered manifest. A thousand-turn session folds
 *  dozens of times; the index must stay a glance, not a second transcript. */
const RENDERED_RANGES = 24;

/**
 * The range a freshly written archive adds to the index, or null when it adds
 * nothing (a rebuild over an already-indexed prefix). `reset` means the indexed
 * ranges describe a prefix this one does not continue — an edited, undone or
 * restored history — so the caller must clear before appending.
 */
export function deriveArchiveRange(
  compacted: readonly Turn[],
  hash: string,
  path: string,
  indexed: readonly ArchiveRange[],
): { range: ArchiveRange; reset: boolean } | null {
  const previous = indexed.at(-1);
  const carried = previous !== undefined
    && previous.endTurn <= compacted.length
    && rangeHash(compacted.slice(0, previous.endTurn)) === previous.rangeHash
    ? previous.endTurn
    : 0;
  const reset = previous !== undefined && carried === 0;
  const delta = compacted.slice(carried);
  if (delta.length === 0) return null;

  const startTurn = carried + 1;
  let userTurns = 0;
  let assistantTurns = 0;
  let firstUserAsk = '';
  for (const turn of delta) {
    if (turn.role === 'user') {
      userTurns++;
      if (!firstUserAsk) firstUserAsk = askSnippet(turn);
    } else {
      assistantTurns++;
    }
  }

  return {
    reset,
    range: {
      rangeHash: hash,
      path,
      startTurn,
      endTurn: startTurn + delta.length - 1,
      userTurns,
      assistantTurns,
      firstUserAsk,
    },
  };
}

/** The manifest section, or '' when nothing has been archived yet. */
export function renderArchiveManifest(ranges: readonly ArchiveRange[]): string {
  if (ranges.length === 0) return '';
  const rendered = ranges.slice(-RENDERED_RANGES);
  const elided = ranges.length - rendered.length;
  return [
    '## Compaction Archive',
    'Ranges folded out of this conversation, archived verbatim. To recover exact prior wording or ' +
      'raw tool output, read the range\'s file with workspace.readFile inside execute_tools — slice ' +
      'it and llm.query each slice when it is large. Each file holds the whole conversation up to ' +
      'its range end, so the file cited on a range is the smallest archive containing it.',
    ...(elided > 0
      ? [`- (${elided} earlier range${elided === 1 ? '' : 's'} elided — the last file below still contains every one of them)`]
      : []),
    ...rendered.map(formatRange),
  ].join('\n');
}

/**
 * Attach the manifest to the ladder's synthesized checkpoint/reference turn —
 * the one turn with no native handle, which is precisely the message that
 * stands in for the compacted prefix. Nothing is attached when the stream was
 * not compacted or the index is empty.
 */
export function withArchiveManifest(turns: readonly Turn[], manifest: string): Turn[] {
  if (!manifest) return [...turns];
  const target = turns.reduce(
    (found, turn, index) => (turn.handle === undefined ? index : found),
    -1,
  );
  if (target < 0) return [...turns];
  return turns.map((turn, index) =>
    index === target
      ? { ...turn, items: [...turn.items, { kind: 'synthetic' as const, key: `${turn.key}#archive-manifest`, text: manifest }] }
      : turn,
  );
}

function formatRange(range: ArchiveRange): string {
  const span = range.startTurn === range.endTurn
    ? `turn ${range.startTurn}`
    : `turns ${range.startTurn}-${range.endTurn}`;
  const ask = range.firstUserAsk ? `"${range.firstUserAsk}"` : '(no user ask)';
  return `- ${span} (${range.userTurns} user / ${range.assistantTurns} assistant) — ${ask} — ${range.path}`;
}

function askSnippet(turn: Turn): string {
  const text = turn.items
    .flatMap((item) => (item.kind === 'text' ? [item.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > ASK_SNIPPET_CHARS ? `${text.slice(0, ASK_SNIPPET_CHARS - 1)}…` : text;
}
