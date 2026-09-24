/** `memory.*` in codemode: projects the native `memory` dispatcher, so both read and write one store. */
import { codemodeText, type CodemodeProvider } from './sandbox-contract';
import * as v from 'valibot';
import { decodeJsonValue, type JsonValue } from '../utils/json';
import { createMemoryDispatcher, type MemoryToolDeps } from './memory-tool';
import { TOOL_REACH } from './registry';
import { branchableToolCall } from './outcome';
import { KinuError } from '../obs';

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

const TYPES_BASE = `  save(content: string): Promise<string>;
`;

/** Without a FactsStore the declaration must not promise fact search. */
const typesSearch = (hasFacts: boolean) => hasFacts
  ? `  /** Notes, and facts by key or value. */
  search(query: string): Promise<string>;
`
  : `  search(query: string): Promise<string>;
`;

const TYPES_TAIL = `  /** Your past conversations: \`query\` searches, \`around_message_id\` reads around a message, neither browses. */
  conversations(opts?: { query?: string; around_message_id?: string; window?: number; limit?: number; max_chars?: number }): Promise<unknown>;`;

const TYPES_FACTS = `
  /** Replaces the value of an existing key. */
  remember(key: string, value: unknown, confidence?: number): Promise<{ ok: boolean; key: string }>;
  recall(key: string): Promise<{ found: boolean; key: string; value?: unknown; confidence?: number }>;
  forget(key: string): Promise<{ ok: boolean; key: string; existed: boolean }>;`;

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
      case 'conversations': {
        const options = v.safeParse(SessionOptionsSchema, args[0] ?? {});

        if (!options.success) throw new KinuError('bad_input', 'memory.conversations: invalid options');

        return decodeMemoryResult({ pending: run({ action: 'conversations', ...options.output }) });
      }

      case 'remember': {
        const confidence = v.safeParse(ConfidenceSchema, args[2]);

        if (!confidence.success) throw new KinuError('bad_input', 'memory.remember: confidence must be a number');

        return decodeMemoryResult({
          pending: run({
            action: 'remember',
            key: codemodeText({ value: args[0], parameter: 'memory.remember(key)' }),
            value: args[1],
            confidence: confidence.output,
          }),
        });
      }

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
