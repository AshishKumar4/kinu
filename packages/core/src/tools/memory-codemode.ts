/**
 * `memory.*` — the durable-state tool, projected into the codemode sandbox.
 *
 * A PROJECTION, not a second implementation: every member calls the SAME
 * `createMemoryDispatcher` output the native `memory` tool is built from
 * (tools/memory-tool.ts), so a script and a direct tool call read and write
 * the identical store. remember/recall/forget appear only when a FactsStore
 * is wired — the same structural gate the native tool's action enum reads.
 */
import type { CodemodeProvider } from '../rlm.js';
import { createMemoryDispatcher, type MemoryToolDeps } from './memory-tool.js';

const TYPES_BASE = `  /** Save a prose note or lesson too long to be a keyed value. */
  save(content: string): Promise<string>;
  /** Search memory notes — hybrid FTS5 + Vectorize (RRF) when a vector store
   *  is wired and available, FTS5-only otherwise. */
  search(query: string): Promise<string>;
  /** Read past session transcripts: pass query to search (all terms must
   *  match), around_message_id to scroll a window, or neither to browse
   *  recent sessions. */
  sessions(opts?: { query?: string; around_message_id?: string; window?: number; limit?: number; max_chars?: number }): Promise<unknown>;`;

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
  const dispatch = (action: string) => (...args: unknown[]): Promise<unknown> => {
    const d = deps();
    const run = createMemoryDispatcher(d);
    switch (action) {
      case 'save':
        return run({ action: 'save', content: String(args[0] ?? '') });
      case 'search':
        return run({ action: 'search', query: String(args[0] ?? '') });
      case 'sessions': {
        const opts = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as {
          query?: string; around_message_id?: string; window?: number; limit?: number; max_chars?: number;
        };
        return run({ action: 'sessions', ...opts });
      }
      case 'remember':
        return run({ action: 'remember', key: String(args[0] ?? ''), value: args[1], confidence: args[2] as number | undefined });
      case 'recall':
        return run({ action: 'recall', key: String(args[0] ?? '') });
      case 'forget':
        return run({ action: 'forget', key: String(args[0] ?? '') });
      default:
        return Promise.resolve({ error: `unknown memory action '${action}'` });
    }
  };

  const tools: CodemodeProvider['tools'] = {
    save: { description: 'Save a prose note or lesson too long to be a keyed value.', execute: dispatch('save') },
    search: { description: 'Search memory notes (hybrid FTS5 + Vectorize when wired).', execute: dispatch('search') },
    sessions: { description: 'Read past session transcripts — search, scroll, or browse.', execute: dispatch('sessions') },
  };
  if (hasFacts) {
    tools.remember = { description: 'Upsert a keyed fact you look up by name later.', execute: dispatch('remember') };
    tools.recall = { description: 'Recall a keyed fact by name.', execute: dispatch('recall') };
    tools.forget = { description: 'Forget a keyed fact by name.', execute: dispatch('forget') };
  }

  return {
    name: 'memory',
    types: `export declare const memory: {\n${TYPES_BASE}${hasFacts ? TYPES_FACTS : ''}\n};\n`,
    tools,
    positionalArgs: true,
  };
}
