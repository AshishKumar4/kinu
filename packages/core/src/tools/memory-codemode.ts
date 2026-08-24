/**
 * `memory.*` — the durable-state tool, projected into the codemode sandbox.
 *
 * A PROJECTION, not a second implementation: every member calls the SAME
 * `createMemoryDispatcher` output the native `memory` tool is built from
 * (tools/memory-tool.ts), so a script and a direct tool call read and write
 * the identical store. remember/recall/forget appear only when a FactsStore
 * is wired — the same structural gate the native tool's action enum reads.
 */
import type { CodemodeProvider } from '../rlm';
import * as v from 'valibot';
import { decodeJsonValue, type JsonValue } from '../utils/json';
import { createMemoryDispatcher, type MemoryToolDeps } from './memory-tool';
import { TOOL_REACH } from './registry';

const SessionOptionsSchema = v.object({
  query: v.optional(v.string()),
  around_message_id: v.optional(v.string()),
  window: v.optional(v.number()),
  limit: v.optional(v.number()),
  max_chars: v.optional(v.number()),
});

const ConfidenceSchema = v.optional(v.number());

async function decodeMemoryResult(input: { pending: Promise<unknown> }): Promise<JsonValue> {
  return decodeJsonValue({ value: await input.pending });
}

const TYPES_BASE = `  /** Save a prose note or lesson too long to be a keyed value. */
  save(content: string): Promise<string>;
  /** Search memory notes — hybrid FTS5 + Vectorize (RRF) when a vector store
   *  is wired and available, FTS5-only otherwise. */
  search(query: string): Promise<string>;
  /** Read this agent's past conversation: pass query to search, an
   *  around_message_id to scroll a window, or neither to browse archived roots. */
  conversations(opts?: { query?: string; around_message_id?: string; window?: number; limit?: number; max_chars?: number }): Promise<unknown>;`;

const TYPES_FACTS = `
  /** Upsert a keyed fact you look up by name later — preferences, project
   *  state, URLs, configuration, dates, decisions. */
  remember(key: string, value: unknown, confidence?: number): Promise<{ ok: boolean; key: string }>;
  /** Recall a keyed fact by name. */
  recall(key: string): Promise<{ found: boolean; key: string; value?: unknown; confidence?: number }>;
  /** Forget a keyed fact by name. */
  forget(key: string): Promise<{ ok: boolean; key: string; existed: boolean }>;`;

/**
 * Build the codemode provider exposing `memory.*`. `deps` is a thunk, read
 * per call, so a re-bound facts/vector store lands without rebuilding the
 * tool. Whether remember/recall/forget exist is read once at construction —
 * a FactsStore is wired for a runtime's whole lifetime, never mid-session.
 */
export function createMemoryCodemodeProvider(deps: () => MemoryToolDeps): CodemodeProvider {
  const hasFacts = !!deps().facts;
  const dispatch = (action: string) => async (...args: unknown[]): Promise<JsonValue> => {
    const d = deps();
    const run = createMemoryDispatcher(d);
    switch (action) {
      case 'save':
        return decodeMemoryResult({ pending: run({ action: 'save', content: String(args[0] ?? '') }) });
      case 'search':
        return decodeMemoryResult({ pending: run({ action: 'search', query: String(args[0] ?? '') }) });
      case 'conversations': {
        const options = v.safeParse(SessionOptionsSchema, args[0] ?? {});
        if (!options.success) return { error: 'memory.conversations: invalid options' };
        return decodeMemoryResult({ pending: run({ action: 'conversations', ...options.output }) });
      }
      case 'remember': {
        const confidence = v.safeParse(ConfidenceSchema, args[2]);
        if (!confidence.success) return { error: 'memory.remember: confidence must be a number' };
        return decodeMemoryResult({
          pending: run({
            action: 'remember',
            key: String(args[0] ?? ''),
            value: args[1],
            confidence: confidence.output,
          }),
        });
      }
      case 'recall':
        return decodeMemoryResult({ pending: run({ action: 'recall', key: String(args[0] ?? '') }) });
      case 'forget':
        return decodeMemoryResult({ pending: run({ action: 'forget', key: String(args[0] ?? '') }) });
      default:
        return { error: `unknown memory action '${action}'` };
    }
  };

  const tools: CodemodeProvider['tools'] = {
    save: { description: 'Save a prose note or lesson too long to be a keyed value.', execute: dispatch('save') },
    search: { description: 'Search memory notes (hybrid FTS5 + Vectorize when wired).', execute: dispatch('search') },
    conversations: { description: 'Read this agent’s past conversation: search, scroll, or browse.', execute: dispatch('conversations') },
  };
  if (hasFacts) {
    tools.remember = { description: 'Upsert a keyed fact you look up by name later.', execute: dispatch('remember') };
    tools.recall = { description: 'Recall a keyed fact by name.', execute: dispatch('recall') };
    tools.forget = { description: 'Forget a keyed fact by name.', execute: dispatch('forget') };
  }

  return {
    name: TOOL_REACH.memory.codemode,
    types: `export declare const memory: {\n${TYPES_BASE}${hasFacts ? TYPES_FACTS : ''}\n};\n`,
    tools,
    positionalArgs: true,
  };
}
