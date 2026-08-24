/**
 * The durable memory surface: prose notes (save/search), keyed facts
 * (remember/recall/forget), and this agent's past conversation transcript.
 *
 * memory.* reaches this same implementation from execute_tools. One
 * dispatcher serves both surfaces.
 */
import type { Memory, SqlExecutor } from '../types/primitives';
import * as v from 'valibot';
import type { FactsStore } from '../memory/facts';
import type { VectorStore } from '../memory/vector-store';
import { appendMemoryNote } from '../memory/note';
import { hybridSearch, memorySnippetRehydrator, type LexicalHit } from '../memory/hybrid-search';
import { ConversationSearchStore } from '../memory/conversation-search';
import { decodeJsonValue, type JsonValue } from '../utils/json';
import {
  memoryActionsFor, unknownActionError,
  type MemoryToolAction, type MEMORY_FACT_ACTIONS,
} from './registry';
import { renderThrownChain } from '../obs/index';

const FactKeySchema = v.pipe(v.string(), v.nonEmpty());


export interface MemoryToolDeps {
  memory: Memory;
  /** Vectorize-backed semantic recall. search auto-hybridises (FTS5 + RRF)
   *  when provided and available; pure FTS5 otherwise. */
  vectorStore?: VectorStore;
  /** Typed keyed world-model store. remember/recall/forget are only
   *  reachable when this is wired. */
  facts?: FactsStore;
  /** Backs the `conversations` action's zero-LLM transcript recall. */
  sql: SqlExecutor;
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
 * ConversationSearchStore holds no state of its own, so the dispatcher is
 * reused by every call the returned function serves. */
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
        finalK: 10, rehydrate: memorySnippetRehydrator(memory),
      });
      if (hits.length === 0) return 'No results found.';
      return hits.map((h) =>
        `[${h.path}:${h.startLine}-${h.endLine}] ` +
        `(rrf ${h.rrfScore.toFixed(3)}, sources: ${h.sources.join('+')})\n${h.snippet}`,
      ).join('\n\n');
    }
    const results = await memory.search(query, 10);
    if (results.length === 0) return 'No results found.';
    return results
      .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`)
      .join('\n\n');
  };

  // `conversations` action: zero-LLM FTS5 transcript recall over the canonical
  // messages table. Mode is inferred from the input:
  // around_message_id -> scroll, query -> search, neither -> browse.
  const conversationSearch = new ConversationSearchStore(deps.sql);
  const runConversationsAction = (args: MemoryToolInput): JsonValue => {
    try {
      if (args.around_message_id) {
        const view = conversationSearch.scroll(args.around_message_id, args.window ?? 5, args.max_chars);
        if (!view) return { error: `no message with id ${args.around_message_id}` };
        return decodeJsonValue({ value: { mode: 'scroll', ...view } });
      }
      if (args.query?.trim()) {
        const hits = conversationSearch.search(args.query, args.limit ?? 5);
        return decodeJsonValue({ value: {
          mode: 'search', query: args.query, hits,
          hint: hits.length > 0
            ? 'Pass a hit\'s messageId as around_message_id to read the surrounding window.'
            : 'No matches. Multi-word queries require all terms; try fewer or different keywords.',
        } });
      }
      return decodeJsonValue({
        value: { mode: 'browse', conversations: conversationSearch.browse(args.limit ?? 10) },
      });
    } catch (err) {
      return { error: `conversation search unavailable: ${renderThrownChain({ cause: err })}` };
    }
  };

  const runFactAction = (
    action: (typeof MEMORY_FACT_ACTIONS)[number],
    args: MemoryToolInput,
  ): JsonValue => {
    if (!facts) return { error: 'the keyed-fact actions are not available on this runtime' };
    const key = v.safeParse(FactKeySchema, args.key);
    if (!key.success) {
      return { error: 'key must be a non-empty string' };
    }
    if (action === 'remember') {
      let value: JsonValue;
      try { value = decodeJsonValue({ value: args.value }); }
      catch (error) { return { error: `value not JSON-serializable: ${renderThrownChain({ cause: error })}` }; }
      facts.upsert(key.output, value, { confidence: args.confidence });
      return { ok: true, key: key.output };
    }
    if (action === 'recall') {
      const f = facts.recall(key.output);
      if (!f) return { found: false, key: key.output };
      return decodeJsonValue({ value: {
        found: true, key: f.key, value: f.value, confidence: f.confidence,
        source: f.source, lastObservedAt: f.lastObservedAt,
      } });
    }
    const existed = facts.recall(key.output) !== null;
    facts.forget(key.output);
    return { ok: true, key: key.output, existed };
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
      return { error: unknownActionError('memory', 'action', args.action, actions) };
    }
    switch (action.output) {
      case 'save':
        if (!args.content) return 'memory.save requires `content`.';
        return appendMemoryNote(memory, args.content);
      case 'search':
        if (!args.query) return 'memory.search requires `query`.';
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
