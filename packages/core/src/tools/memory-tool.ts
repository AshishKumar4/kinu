/**
 * The `memory` tool's dispatch logic — prose notes (save/search, auto-hybrid
 * FTS5 + Vectorize), the typed keyed world model (remember/recall/forget,
 * gated on a FactsStore), and past session transcripts (sessions).
 *
 * Factored out so `memory.*` can reach the SAME implementation from inside
 * execute_tools (tools/memory-codemode.ts) that the native `memory` tool
 * calls — one dispatcher, two callers, mirroring tools/agents-tool.ts.
 */
import type { Memory, SqlExecutor } from '../types/primitives.js';
import * as v from 'valibot';
import type { FactsStore } from '../memory/facts.js';
import type { VectorStore } from '../memory/vector-store.js';
import { appendMemoryNote } from '../memory/note.js';
import { hybridSearch, memorySnippetRehydrator, type LexicalHit } from '../memory/hybrid-search.js';
import { SessionSearchStore } from '../memory/session-search.js';
import { decodeJsonValue, type JsonValue } from '../utils/json.js';
import {
  memoryActionsFor, unknownActionError,
  type MemoryToolAction, type MEMORY_FACT_ACTIONS,
} from './registry.js';

const FactKeySchema = v.pipe(v.string(), v.nonEmpty());

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MemoryToolDeps {
  memory: Memory;
  /** Vectorize-backed semantic recall. search auto-hybridises (FTS5 + RRF)
   *  when provided and available; pure FTS5 otherwise. */
  vectorStore?: VectorStore;
  /** Typed keyed world-model store. remember/recall/forget are only
   *  reachable when this is wired. */
  facts?: FactsStore;
  /** Backs the `sessions` action's zero-LLM FTS5 transcript recall. */
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

/** Build a memory dispatcher over one runtime's stores. Constructed once —
 *  SessionSearchStore holds no state of its own, so this is cheap — and
 *  reused by every call the returned function serves. */
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

  // `sessions` action — zero-LLM FTS5 transcript recall over the canonical
  // messages table (one store, both backends). Mode inferred Hermes-style:
  // around_message_id → scroll, query → search, neither → browse.
  const sessionSearch = new SessionSearchStore(deps.sql);
  const runSessionsAction = (args: MemoryToolInput): JsonValue => {
    try {
      if (args.around_message_id) {
        const view = sessionSearch.scroll(args.around_message_id, args.window ?? 5, args.max_chars);
        if (!view) return { error: `no message with id ${args.around_message_id}` };
        return decodeJsonValue({ value: { mode: 'scroll', ...view } });
      }
      if (args.query?.trim()) {
        const hits = sessionSearch.search(args.query, args.limit ?? 5);
        return decodeJsonValue({ value: {
          mode: 'search', query: args.query, hits,
          hint: hits.length > 0
            ? 'Pass a hit\'s messageId as around_message_id to read the surrounding window.'
            : 'No matches. Multi-word queries require all terms; try fewer or different keywords.',
        } });
      }
      return decodeJsonValue({
        value: { mode: 'browse', sessions: sessionSearch.browse(args.limit ?? 10) },
      });
    } catch (err) {
      return { error: `session search unavailable: ${err instanceof Error ? err.message : String(err)}` };
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
      catch (error) { return { error: `value not JSON-serializable: ${errorMessage({ error })}` }; }
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
      case 'sessions':
        return runSessionsAction(args);
      case 'remember':
      case 'recall':
      case 'forget':
        return runFactAction(action.output, args);
    }
  };
}
