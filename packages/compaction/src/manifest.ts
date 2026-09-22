/**
 * Archive manifest: one mechanical line per archived range, appended to the checkpoint message.
 * Each compaction archives prefix `[0, boundary)`; a range's `rangeHash` is the hash of the prefix it
 * ended, so re-hashing proves continuation or signals a rewritten history.
 */

import { rangeHash, type Turn } from '@better-compact/core';

export interface ArchiveRange {
  /** Hash of the whole compacted prefix ending at `endTurn`: archive identity and continuation proof. */
  rangeHash: string;
  path: string;
  /** 1-based turn ordinals. */
  startTurn: number;
  endTurn: number;
  userTurns: number;
  assistantTurns: number;
  /** First user ask inside the range, one line, bounded. */
  firstUserAsk: string;
}

/** Append-only within one history; cleared when that history is rewritten. */
export interface ArchiveIndexStore {
  list(sessionKey: string): ArchiveRange[];
  /** A repeat of the same `rangeHash` is a no-op. */
  append(sessionKey: string, range: ArchiveRange): void;
  clear(sessionKey: string): void;
}

const ASK_SNIPPET_CHARS = 120;

/** Keeps the manifest a glance, not a second transcript. */
const RENDERED_RANGES = 24;

/** The range a new archive adds, or null; `reset` means the caller must clear the index first. */
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

export function renderArchiveManifest(ranges: readonly ArchiveRange[]): string {
  if (ranges.length === 0) return '';
  const rendered = ranges.slice(-RENDERED_RANGES);
  const elided = ranges.length - rendered.length;

  return [
    '## Compaction Archive',
    'Ranges folded out of this conversation, archived verbatim. To recover exact prior wording or ' +
      'raw tool output, read the range\'s file with workspace.readFile inside eval — or name ' +
      'its path in the message of a lifetime:"task" agents hire when it is large, so that agent reads ' +
      'it instead of you. Each file ' +
      'holds the whole conversation up to ' +
      'its range end, so the file cited on a range is the smallest archive containing it.',
    ...(elided > 0
      ? [`- (${elided} earlier range${elided === 1 ? '' : 's'} elided — the last file below still contains every one of them)`]
      : []),
    ...rendered.map(formatRange),
  ].join('\n');
}

/** Attach the manifest to the synthesized checkpoint turn (the one with no native handle), if any. */
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
