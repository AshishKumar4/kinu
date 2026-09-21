/**
 * The durable memory surface: prose notes (save/search), keyed facts
 * (remember/recall/forget), and this agent's past conversation transcript.
 *
 * memory.* reaches this same implementation from eval. One
 * dispatcher serves both surfaces.
 */
import type { Memory, MemorySearchResult, SqlExecutor } from '../types/primitives';
import * as v from 'valibot';
import type { VectorStore } from '../memory/vector-store';
import { reciprocalRankFusion } from '../memory/vector-store';
import type { ActorHandle } from '../identity/actor-handle';
import { appendMemoryNote } from '../memory/note';
import { normalizeFactKey, searchFacts, type FactSearchHit, type FactsStore } from '../memory/facts';
import { hybridSearch, memorySnippetRehydrator, type LexicalHit } from '../memory/hybrid-search';
import { ConversationSearchStore } from '../memory/conversation-search';
import type { SessionTranscriptReader } from '../orchestrator/session-transcript';
import { decodeJsonValue, type JsonValue } from '../utils/json';
import {
  memoryActionsFor, unknownActionError,
  type MemoryToolAction, type MEMORY_FACT_ACTIONS,
} from './registry';
import { KinuError, toKinuError, renderThrownChain } from '../obs/index';

const FactKeySchema = v.pipe(v.string(), v.nonEmpty());


export interface MemoryToolDeps {
  memory: Memory;
  /** null explicitly declares a backend without a semantic index. Search
   *  reports lexical-only coverage when absent or unavailable. */
  vectorStore?: VectorStore | null;
  /** Typed keyed world-model store. remember/recall/forget are only
   *  reachable when this is wired. */
  facts?: FactsStore;
  /** Backs the `conversations` action's zero-LLM transcript recall. */
  sql: SqlExecutor;
  /** Whose transcript that recall reads. The conversation store is bound to
   *  one actor, so a dispatcher built for this runtime can only ever read the
   *  rows this runtime owns. */
  readonly actor: ActorHandle;
  /** Reader for one session's canonical transcript. Entry text is not a
   *  column: recall materializes it through this, so the recalled words are
   *  the ones the canonical message parts hold. */
  readonly transcriptFor: (sessionId: string) => SessionTranscriptReader;
}

/** The durable-state tool's one input shape. `key` names a fact, `content` /
 *  `query` address prose, and the rest scope a session read — which of them
 *  the call needs follows from its action. */
export interface MemoryToolInput {
  action: MemoryToolAction;
  key?: string;
  value?: unknown;
  confidence?: number;
  content?: string;
  query?: string;
  around_message_id?: string;
  window?: number;
  limit?: number;
  max_chars?: number;
}

/** Build a memory dispatcher over one runtime's stores. Constructed once.
 * ConversationSearchStore is bound to `deps.actor` and holds no other state, so
 * the dispatcher is reused by every call the returned function serves — a
 * runtime's actor does not change under it. */
export function createMemoryDispatcher(deps: MemoryToolDeps): (input: MemoryToolInput) => Promise<JsonValue> {
  const { memory, vectorStore: vs, facts } = deps;

  const searchMemory = async (query: string): Promise<string> => {
    if (vs && vs.available) {
      const lexicalFn = async (q: string, k: number): Promise<LexicalHit[]> => {
        const results = await memory.search(q, k);

        return results.map((r) => ({
          // Canonical chunk id (`path:start-end`) — matches the id the vector
          // store returns, so RRF fuses the lexical and semantic hits.
          id: `${r.path}:${r.startLine}-${r.endLine}`,
          path: r.path, startLine: r.startLine, endLine: r.endLine,
          score: r.score, snippet: r.snippet,
        }));
      };

      const hits = await hybridSearch(query, lexicalFn, vs, {
        finalK: 10, rehydrate: memorySnippetRehydrator(memory), facts,
      });

      if (hits.length === 0) return 'No results found.';

      return hits.map((h) =>
        `[${h.label ?? `${h.path}:${h.startLine}-${h.endLine}`}] ` +
        `(rrf ${h.rrfScore.toFixed(3)}, sources: ${h.sources.join('+')})\n${h.snippet}`,
      ).join('\n\n');
    }

    const results = await memory.search(query, 10);

    const coverage = 'Lexical search only; semantic recall is unavailable.';

    if (!facts) {
      // No second lexical source: the note page IS the answer, rendered
      // unchanged.
      if (results.length === 0) return `${coverage}\nNo results found.`;

      return `${coverage}\n` + results
        .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`)
        .join('\n\n');
    }

    // Facts are the second lexical source, fused through the same RRF the
    // hybrid path uses — one ordering policy, no separate ranking. A fact hit
    // renders its key and score where a note hit shows its chunk address.
    const merged = reciprocalRankFusion<(MemorySearchResult & { id: string; kind: 'note' }) | (FactSearchHit & { kind: 'fact' })>(
      [
        results.map((r) => ({ ...r, id: `${r.path}:${r.startLine}-${r.endLine}`, kind: 'note' as const })),
        searchFacts(facts, query, 10).map((f) => ({ ...f, kind: 'fact' as const })),
      ],
    ).slice(0, 10);

    if (merged.length === 0) return `${coverage}\nNo results found.`;

    return `${coverage}\n` + merged.map((m) => {
      const hit = m.sources[0];

      return hit.kind === 'note'
        ? `[${hit.path}:${hit.startLine}-${hit.endLine}] (score ${hit.score.toFixed(2)})\n${hit.snippet}`
        : `[fact: ${hit.key}] (rrf ${m.rrfScore.toFixed(3)}, sources: ${hit.kind})\n${hit.snippet}`;
    }).join('\n\n');
  };

  // `conversations` action: zero-LLM FTS5 transcript recall over the canonical
  // conversation store. Mode is inferred from the input:
  // around_message_id -> scroll, query -> search, neither -> browse.
  const conversationSearch = new ConversationSearchStore(deps.sql, deps.actor, deps.transcriptFor);

  const runConversationsAction = async (args: MemoryToolInput): Promise<JsonValue> => {
    try {
      if (args.around_message_id) {
        const view = await conversationSearch.scroll(args.around_message_id, args.window ?? 5, args.max_chars);

        if (!view) throw new KinuError('missing', 'no message with id ' + args.around_message_id);

        return decodeJsonValue({ value: { mode: 'scroll', ...view } });
      }

      if (args.query?.trim()) {
        const hits = await conversationSearch.search(args.query, args.limit ?? 5);

        return decodeJsonValue({ value: {
          mode: 'search', query: args.query, hits,
          hint: hits.length > 0
            ? 'Pass a hit\'s messageId as around_message_id to read the surrounding window.'
            : 'No matches. Multi-word queries require all terms; try fewer or different keywords.',
        } });
      }

      return decodeJsonValue({
        value: { mode: 'browse', conversations: await conversationSearch.browse(args.limit ?? 10) },
      });
    } catch (err) {
      if (err instanceof KinuError) throw err;
      const failure = toKinuError({ doing: 'conversation search unavailable', cause: err, otherwise: 'unavailable' });
      failure.message = renderThrownChain({ cause: failure });
      throw failure;
    }
  };

  const runFactAction = (
    action: (typeof MEMORY_FACT_ACTIONS)[number],
    args: MemoryToolInput,
  ): JsonValue => {
    if (!facts) throw new KinuError('unsupported', 'the keyed-fact actions are not available on this runtime');
    const key = v.safeParse(FactKeySchema, args.key);

    if (!key.success) {
      throw new KinuError('bad_input', 'key must be a non-empty string');
    }

    // The store folds a key to one spelling on every call. The tool's own
    // answers must name that same spelling — otherwise the model is told a
    // fact is "every-tool probe" and reads it back as "every-tool_probe":
    // two names for one row, and a caller checking its own echo misses.
    const storedKey = normalizeFactKey(key.output);

    if (action === 'remember') {
      let value: JsonValue;

      try { value = decodeJsonValue({ value: args.value }); }
      catch (error) { throw new KinuError('bad_input', 'value not JSON-serializable', { cause: error }); }

      facts.upsert(storedKey, value, { confidence: args.confidence });

      return { ok: true, key: storedKey };
    }

    if (action === 'recall') {
      const f = facts.recall(storedKey);

      if (!f) return { found: false, key: storedKey };

      return decodeJsonValue({ value: {
        found: true, key: f.key, value: f.value, confidence: f.confidence,
        source: f.source, lastObservedAt: f.lastObservedAt,
      } });
    }

    const existed = facts.recall(storedKey) !== null;
    facts.forget(storedKey);

    return { ok: true, key: storedKey, existed };
  };

  const actions = memoryActionsFor(!!facts);
  const ActionSchema = v.picklist(actions);

  return async (args: MemoryToolInput): Promise<JsonValue> => {
    // The declared `MemoryToolAction` is a claim, not a fact: the AI SDK leaves
    // `Schema.validate` undefined for a jsonSchema-declared tool input, so this
    // is whatever the model emitted. Refused WITH the vocabulary — and with the
    // gated half omitted when this runtime has no FactsStore, from the same
    // `memoryActionsFor` the enum in the schema is built from, so the words in
    // the refusal are exactly the words that work.
    const action = v.safeParse(ActionSchema, args.action);

    if (!action.success) {
      throw new KinuError('bad_input', unknownActionError('memory', 'action', args.action, actions));
    }

    switch (action.output) {
      case 'save':
        if (!args.content) throw new KinuError('bad_input', 'memory.save requires `content`.');

        return appendMemoryNote(memory, args.content, { by: deps.actor.name });
      case 'search':
        if (!args.query) throw new KinuError('bad_input', 'memory.search requires `query`.');

        return searchMemory(args.query);
      case 'conversations':
        return runConversationsAction(args);
      case 'remember':
      case 'recall':
      case 'forget':
        return runFactAction(action.output, args);
    }
  };
}
