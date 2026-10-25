/**
 * What a turn's question recalls of memory, read once as the turn is prepared and shown in every step's block outside the
 * cached prefix (`renderMemoryForTurn`): the one hybrid search (`searchMemoryHits`: the notes' FTS5, Vectorize where
 * bound, the workspace's facts and the account's the turn read) keyed on what the turn asks. The account's notes are the
 * memory tool's to search: each would cross to the account's object once more a turn. A fact is named by its key, so each step
 * shows its value as it then is; a note keeps the words that matched, with when it was written and whether a fact has
 * since changed what it says.
 */

import { Cause, Exit } from 'effect';
import type { Memory } from '../types/primitives';
import { attempt, diagnostics, hold, toKinuError } from '../obs/index';
import type { VectorStore } from './vector-store';
import { renderFactValue, type Fact, type FactsStore, type MemoryScope } from './facts';
import { searchMemoryHits } from './memory-search';

export type RecalledMemory =
  | { readonly kind: 'fact'; readonly key: string; readonly scope: MemoryScope }
  | {
    readonly kind: 'note';
    /** A note's `path:start-end`, or `account note: <id>`. */
    readonly ref: string;
    readonly text: string;
    /** When it was written, where its heading dates it. */
    readonly at: number | null;
    /** The fact whose newer value replaces one this note states. */
    readonly supersededBy: string | null;
  };

export interface RecallSources {
  readonly memory: Pick<Memory, 'search' | 'chunk'>;
  /** Null where none is bound (the CLI): the notes are matched by FTS5 alone. */
  readonly vectorStore: VectorStore | null;
  readonly facts: FactsStore;
  /** The account's facts as the turn read them (`TurnAssemblySources.accountFacts`); absent where it has none. */
  readonly accountFacts?: readonly Fact[];
}

/** The hybrid search's own default page: what the block's budget then chooses among. */
const RECALLED = 10;

/** A note's heading as `appendMemoryNote` writes it: `### Note (2026-10-25 · main)`. */
const NOTE_DATE = /^#{2,3} [^\n]*\((\d{4}-\d{2}-\d{2})/gmu;

/** The newest date a note's headings carry; null where none does. */
function noteDate(text: string): number | null {
  const dates = [...text.matchAll(NOTE_DATE)].map((match) => Date.parse(match[1] ?? '')).filter((at) => !Number.isNaN(at));

  return dates.length === 0 ? null : Math.max(...dates);
}

const WORD = /[\p{L}\p{N}]/u;

/** Whether `text` states `value` whole, not inside a longer word or number (`3` is not stated by `2023`). */
function statesWhole(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    if (!WORD.test(text[at - 1] ?? ' ') && !WORD.test(text[at + value.length] ?? ' ')) return true;
  }

  return false;
}

/** The first of `keys` an earlier value of which `text` states, changed after `at`: what the note says is no longer the
 *  fact. */
function supersedingFact(facts: FactsStore, keys: readonly string[], text: string, at: number | null): string | null {
  return keys.find((key) => {
    const [current, ...earlier] = facts.history(key);

    if (current === undefined || current.forgotten || (at !== null && current.at <= at)) return false;
    const now = renderFactValue(current.value);

    return earlier.some((revision) => {
      const was = revision.value === null ? '' : renderFactValue(revision.value);

      return was.trim() !== '' && was !== now && !statesWhole(text, now) && statesWhole(text, was);
    });
  }) ?? null;
}

/** What `question` matches in memory, best first; none for a turn that asks nothing, and none where the search fails,
 *  which is logged: the turn goes on without it, as it does without the account's facts. */
export async function recallForTurn(sources: RecallSources, question: string): Promise<readonly RecalledMemory[]> {
  if (question.trim() === '') return [];
  const { facts, accountFacts } = sources;
  const doing = "searching the memory a turn's words match";

  const searched = await hold(attempt({ doing, otherwise: 'io' }, () => searchMemoryHits(sources.memory, sources.vectorStore, question, {
    limit: RECALLED, facts, ...(accountFacts !== undefined && { account: { facts: async () => accountFacts } }),
  })));

  if (Exit.isFailure(searched)) {
    diagnostics.failure('memory.turn_recall_failed', toKinuError({ doing, cause: Cause.squash(searched.cause), otherwise: 'io' }));

    return [];
  }

  const { hits } = searched.value;
  const matchedKeys = hits.flatMap((hit) => (hit.factKey !== undefined && hit.scope === 'workspace' ? [hit.factKey] : []));

  return hits.map((hit): RecalledMemory => {
    if (hit.factKey !== undefined) return { kind: 'fact', key: hit.factKey, scope: hit.scope };
    const at = noteDate(hit.snippet);

    return {
      kind: 'note', ref: hit.label ?? `${hit.path}:${String(hit.startLine)}-${String(hit.endLine)}`, text: hit.snippet, at,
      supersededBy: supersedingFact(facts, matchedKeys, hit.snippet, at),
    };
  });
}
