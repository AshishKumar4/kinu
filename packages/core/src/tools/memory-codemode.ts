/** `memory.*` in codemode: projects the native `memory` dispatcher, so both read and write one store. */
import { Effect } from 'effect';
import { codemodeText, type CodemodeProvider } from './sandbox-contract';
import type { z } from 'zod';
import { decodeJsonValue, type JsonValue } from '../utils/json';
import { ConfidenceSchema, createMemoryDispatcher, MemoryToolInputSchema, type MemoryToolDeps } from './memory-tool';
import { refusedInput, settle } from '../obs/index';
import { TOOL_REACH } from './registry';
import { branchableToolCall } from './outcome';
import { KinuError } from '../obs';

/** The native tool's own fields: one schema, whether the call came as a tool or a program. */
const SessionOptionsSchema = MemoryToolInputSchema.pick({ query: true, around_message_id: true, window: true, limit: true, max_chars: true });

function parsed<T>(method: string, result: z.ZodSafeParseResult<T>): Effect.Effect<T, KinuError> {
  return result.success ? Effect.succeed(result.data) : Effect.fail(refusedInput(`memory.${method}`, result.error));
}

function decodeMemoryResult(run: () => Promise<JsonValue>): Effect.Effect<JsonValue> {
  return Effect.map(Effect.promise(() => run()), (value) => decodeJsonValue({ value }));
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

  const dispatched = (action: string, args: readonly unknown[]): Effect.Effect<JsonValue, KinuError> => Effect.gen(function* () {
    const d = deps();
    const run = createMemoryDispatcher(d);

    switch (action) {
      case 'save': {
        const content = codemodeText({ value: args[0], parameter: 'memory.save(content)' });

        return yield* decodeMemoryResult(() => run({ action: 'save', content }));
      }

      case 'search': {
        const query = codemodeText({ value: args[0], parameter: 'memory.search(query)' });

        return yield* decodeMemoryResult(() => run({ action: 'search', query }));
      }

      case 'conversations': {
        const options = yield* parsed('conversations', SessionOptionsSchema.safeParse(args[0] ?? {}));

        return yield* decodeMemoryResult(() => run({ action: 'conversations', ...options }));
      }

      case 'remember': {
        const key = codemodeText({ value: args[0], parameter: 'memory.remember(key)' });
        const confidence = yield* parsed('remember', ConfidenceSchema.safeParse(args[2]));

        return yield* decodeMemoryResult(() => run({ action: 'remember', key, value: args[1], confidence }));
      }

      case 'recall': {
        const key = codemodeText({ value: args[0], parameter: 'memory.recall(key)' });

        return yield* decodeMemoryResult(() => run({ action: 'recall', key }));
      }

      case 'forget': {
        const key = codemodeText({ value: args[0], parameter: 'memory.forget(key)' });

        return yield* decodeMemoryResult(() => run({ action: 'forget', key }));
      }

      default:
        return yield* new KinuError('bad_input', `unknown memory action '${action}'`);
    }
  });

  const tools: CodemodeProvider['tools'] = {
    save: { planAllowed: true, description: 'Save a prose note or lesson too long to be a keyed value.', execute: (...args: unknown[]) => branchableToolCall(() => settle(dispatched('save', args))) },
    search: {
      planAllowed: true,
      description: hasFacts
        ? 'Search memory notes and remembered facts (key or value); hybrid FTS5 + Vectorize over notes when wired.'
        : 'Search memory notes (hybrid FTS5 + Vectorize when wired).',
      execute: (...args: unknown[]) => branchableToolCall(() => settle(dispatched('search', args))),
    },
    conversations: { planAllowed: true, description: 'Read this agent\'s past conversation: search, scroll, or browse.', execute: (...args: unknown[]) => branchableToolCall(() => settle(dispatched('conversations', args))) },
  };

  if (hasFacts) {
    tools.remember = { planAllowed: true, description: 'Upsert a keyed fact you look up by name later.', execute: (...args: unknown[]) => branchableToolCall(() => settle(dispatched('remember', args))) };
    tools.recall = { planAllowed: true, description: 'Recall a keyed fact by name.', execute: (...args: unknown[]) => branchableToolCall(() => settle(dispatched('recall', args))) };
    tools.forget = { planAllowed: true, description: 'Forget a keyed fact by name.', execute: (...args: unknown[]) => branchableToolCall(() => settle(dispatched('forget', args))) };
  }

  return {
    name: TOOL_REACH.memory.codemode,
    types: `export declare const memory: {\n${TYPES_BASE}${typesSearch(hasFacts)}${TYPES_TAIL}${hasFacts ? TYPES_FACTS : ''}\n};\n`,
    tools,
    positionalArgs: true,
  };
}
