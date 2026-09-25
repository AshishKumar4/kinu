/** Durable memory surface: prose notes, keyed facts, and past transcript recall. Also backs `memory.*` in eval. */
import type { Memory, MemorySearchResult, SqlExecutor } from '../types/primitives';
import * as v from 'valibot';
import { z } from 'zod';
import { oneOf } from './tool-schema';
import type { VectorStore } from '../memory/vector-store';
import { reciprocalRankFusion } from '../memory/vector-store';
import type { ActorHandle } from '../identity/actor-handle';
import { appendMemoryNote } from '../memory/note';
import { normalizeFactKey, searchFacts, type FactSearchHit, type FactsStore } from '../memory/facts';
import { hybridSearch, memorySnippetRehydrator, type LexicalHit } from '../memory/hybrid-search';
import { ConversationSearchStore } from '../memory/conversation-search';
import type { SessionTranscriptReader } from '../session/transcript';
import { decodeJsonValue, type JsonValue } from '../utils/json';
import { memoryActionsFor, type MEMORY_FACT_ACTIONS } from './registry';
import { KinuError, toKinuError, renderThrownChain } from '../obs/index';

const FactKeySchema = v.pipe(v.string(), v.nonEmpty());


export interface MemoryToolDeps {
  memory: Memory;
  /** null: no semantic index; search reports lexical-only coverage. */
  vectorStore?: VectorStore | null;
  /** remember/recall/forget are reachable only when set. */
  facts?: FactsStore;
  sql: SqlExecutor;
  /** Conversation store is bound to this actor, so recall reads only its rows. */
  readonly actor: ActorHandle;
  /** Recall materializes entry text through this reader; text is not a column. */
  readonly transcriptFor: (sessionId: string) => SessionTranscriptReader;
}

/** A remembered fact's confidence; `memory.remember` in eval takes it positionally. */
/** Clamped into 0-1, as the facts store clamps it, so a percentage saves as certain rather than being refused. */
export const ConfidenceSchema = z.number().transform((n) => Math.min(1, Math.max(0, n)))
  .describe('For remember: 0 to 1; default 1.').optional();

/** Input of the native tool and of `memory.*` in eval. */
export const MemoryToolInputSchema = z.object({
  action: oneOf(memoryActionsFor(true)).describe(
    'remember, recall, forget: a keyed fact. save: a note. search: notes and facts. conversations: your past conversations.',
  ),
  key: z.string().describe('For remember, recall, forget: a stable name such as "deploy.target".').optional(),
  value: z.unknown().describe('For remember: any JSON value.').optional(),
  confidence: ConfidenceSchema,
  content: z.string().describe('For save.').optional(),
  query: z.string()
    .describe('For search. For conversations: every term must match; omit it to browse archived conversations.').optional(),
  around_message_id: z.string().describe('For conversations: read around this message instead of searching.').optional(),
  window: z.number().describe('For conversations around a message: messages each side (default 5, max 20).').optional(),
  max_chars: z.number().describe('For conversations around a message: characters per message (default 700).').optional(),
  limit: z.number()
    .describe('For conversations: max hits (default 5, max 10), or archived conversations (default 10, max 20).').optional(),
});

export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

/** Without a FactsStore the fact actions are neither offered nor accepted. */
export function memoryToolInputSchema(hasFacts: boolean): typeof MemoryToolInputSchema {
  return hasFacts ? MemoryToolInputSchema : MemoryToolInputSchema.extend({
    action: oneOf(memoryActionsFor(false)).describe('save: a note. search: notes. conversations: your past conversations.'),
  });
}

export function createMemoryDispatcher(deps: MemoryToolDeps): (input: MemoryToolInput) => Promise<JsonValue> {
  const { memory, vectorStore: vs, facts } = deps;

  const searchMemory = async (query: string): Promise<string> => {
    if (vs && vs.available) {
      const lexicalFn = async (q: string, k: number): Promise<LexicalHit[]> => {
        const results = await memory.search(q, k);

        return results.map((r) => ({
          // Canonical chunk id, matching the vector store's so RRF fuses both.
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
      if (results.length === 0) return `${coverage}\nNo results found.`;

      return `${coverage}\n` + results
        .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`)
        .join('\n\n');
    }

    // Facts fuse through the same RRF as the hybrid path.
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

  // Mode: around_message_id -> scroll, query -> search, neither -> browse.
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

    // Answers must echo the store's normalized spelling of the key.
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

  return async (args: MemoryToolInput): Promise<JsonValue> => {
    switch (args.action) {
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
        return runFactAction(args.action, args);
    }
  };
}
