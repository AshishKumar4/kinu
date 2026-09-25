/** `memory.*` in codemode: projects the native `memory` dispatcher, so both read and write one store. */
import { codemodeText, type CodemodeProvider } from './sandbox-contract';
import type { z } from 'zod';
import { decodeJsonValue, type JsonValue } from '../utils/json';
import { ConfidenceSchema, createMemoryDispatcher, MemoryToolInputSchema, type MemoryToolDeps } from './memory-tool';
import { refusedInput } from '../obs/index';
import { TOOL_REACH } from './registry';
import { branchableToolCall } from './outcome';
import { KinuError } from '../obs';

/** The native tool's own fields: one schema, whether the call came as a tool or a program. */
const SessionOptionsSchema = MemoryToolInputSchema.pick({ query: true, around_message_id: true, window: true, limit: true, max_chars: true });

function parsed<T>(method: string, result: z.ZodSafeParseResult<T>): T {
  if (!result.success) throw refusedInput(`memory.${method}`, result.error);

  return result.data;
}

async function decodeMemoryResult(input: { pending: Promise<unknown> }): Promise<JsonValue> {
  return decodeJsonValue({ value: await input.pending });
}

const TYPES_BASE = `  save(content: string): Promise<string | Refusal>;
`;

/** Without a FactsStore the declaration must not promise fact search. */
const typesSearch = (hasFacts: boolean) => hasFacts
  ? `  /** Notes, and facts by key or value. */
  search(query: string): Promise<string | Refusal>;
`
  : `  search(query: string): Promise<string | Refusal>;
`;

const TYPES_TAIL = `  /** Your past conversations: \`query\` searches, \`around_message_id\` reads around a message, neither browses. */
  conversations(opts?: { query?: string; around_message_id?: string; window?: number; limit?: number; max_chars?: number }): Promise<unknown>;`;

const TYPES_FACTS = `
  /** Replaces the value of an existing key. */
  remember(key: string, value: unknown, confidence?: number): Promise<{ ok: boolean; key: string } | Refusal>;
  recall(key: string): Promise<{ found: boolean; key: string; value?: unknown; confidence?: number } | Refusal>;
  forget(key: string): Promise<{ ok: boolean; key: string; existed: boolean } | Refusal>;`;

/** `deps` is read per call so rebound stores apply; the facts gate is read once (a FactsStore never changes mid-session). */
export function createMemoryCodemodeProvider(deps: () => MemoryToolDeps): CodemodeProvider {
  const hasFacts = deps().facts !== undefined;

  const dispatch = (action: string) => (...args: unknown[]) => branchableToolCall(async (): Promise<JsonValue> => {
    const d = deps();
    const run = createMemoryDispatcher(d);

    switch (action) {
      case 'save':
        return decodeMemoryResult({ pending: run({ action: 'save', content: codemodeText({ value: args[0], parameter: 'memory.save(content)' }) }) });
      case 'search':
        return decodeMemoryResult({ pending: run({ action: 'search', query: codemodeText({ value: args[0], parameter: 'memory.search(query)' }) }) });
      case 'conversations':
        return decodeMemoryResult({ pending: run({ action: 'conversations', ...parsed('conversations', SessionOptionsSchema.safeParse(args[0] ?? {})) }) });
      case 'remember':
        return decodeMemoryResult({
          pending: run({
            action: 'remember',
            key: codemodeText({ value: args[0], parameter: 'memory.remember(key)' }),
            value: args[1],
            confidence: parsed('remember', ConfidenceSchema.safeParse(args[2])),
          }),
        });

      case 'recall':
        return decodeMemoryResult({ pending: run({ action: 'recall', key: codemodeText({ value: args[0], parameter: 'memory.recall(key)' }) }) });
      case 'forget':
        return decodeMemoryResult({ pending: run({ action: 'forget', key: codemodeText({ value: args[0], parameter: 'memory.forget(key)' }) }) });
      default:
        throw new KinuError('bad_input', `unknown memory action '${action}'`);
    }
  });

  const tools: CodemodeProvider['tools'] = {
    save: { planAllowed: true, description: 'Save a prose note or lesson too long to be a keyed value.', execute: dispatch('save') },
    search: {
      planAllowed: true,
      description: hasFacts
        ? 'Search memory notes and remembered facts (key or value); hybrid FTS5 + Vectorize over notes when wired.'
        : 'Search memory notes (hybrid FTS5 + Vectorize when wired).',
      execute: dispatch('search'),
    },
    conversations: { planAllowed: true, description: 'Read this agent’s past conversation: search, scroll, or browse.', execute: dispatch('conversations') },
  };

  if (hasFacts) {
    tools.remember = { planAllowed: true, description: 'Upsert a keyed fact you look up by name later.', execute: dispatch('remember') };
    tools.recall = { planAllowed: true, description: 'Recall a keyed fact by name.', execute: dispatch('recall') };
    tools.forget = { planAllowed: true, description: 'Forget a keyed fact by name.', execute: dispatch('forget') };
  }

  return {
    name: TOOL_REACH.memory.codemode,
    types: `export declare const memory: {\n${TYPES_BASE}${typesSearch(hasFacts)}${TYPES_TAIL}${hasFacts ? TYPES_FACTS : ''}\n};\n`,
    tools,
    positionalArgs: true,
  };
}
