import * as v from 'valibot';
import type { CodemodeProvider } from './sandbox-contract';
import type { CodemodeResult } from '../types/codemode';
import { KeySchema, type ProgramStateStore } from '../identity/program-state';
import { JsonValueSchema } from '../utils/json';
import { KinuError, refusalOf } from '../obs/error';

const STATE_NAMESPACE = 'state';

const PrefixSchema = v.optional(v.string());

const STATE_TYPES = `type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };
export declare const state: {
  get(key: string): Promise<StateValue | Refusal>;
  set(key: string, value: StateValue): Promise<{ ok: true } | Refusal>;
  delete(key: string): Promise<{ ok: true } | Refusal>;
  list(prefix?: string): Promise<string[] | Refusal>;
};`;

function onFirst<T>(
  schema: v.GenericSchema<unknown, T>,
  refusal: string,
  run: (first: T, rest: readonly unknown[]) => CodemodeResult | Promise<CodemodeResult>,
): (...args: unknown[]) => Promise<CodemodeResult> {
  return async (...args) => {
    const first = v.safeParse(schema, args[0]);

    if (!first.success) return refusalOf(new KinuError('bad_input', refusal));

    return run(first.output, args.slice(1));
  };
}

export function createStateCodemodeProvider(state: ProgramStateStore): CodemodeProvider {
  return {
    name: STATE_NAMESPACE, types: STATE_TYPES, positionalArgs: true,
    tools: {
      get: {
        planAllowed: true, description: 'Read a saved JSON value; null when absent.',
        execute: onFirst(KeySchema, 'state.get(key): key must be a non-empty string', (key) => state.get(key)),
      },
      set: {
        planAllowed: true, description: 'Save a JSON value under a key.',
        execute: onFirst(KeySchema, 'state.set(key, value): key must be a non-empty string', (key, [raw]) => {
          const value = v.safeParse(JsonValueSchema, raw === undefined ? null : raw);

          if (!value.success) return refusalOf(new KinuError('bad_input', 'state.set(key, value): value must be JSON-serializable'));
          state.set(key, value.output);

          return { ok: true };
        }),
      },
      delete: {
        planAllowed: true, description: 'Remove a saved key.',
        execute: onFirst(KeySchema, 'state.delete(key): key must be a non-empty string', (key) => {
          state.delete(key);

          return { ok: true };
        }),
      },
      list: {
        planAllowed: true, description: 'List saved keys, optionally under a prefix.',
        execute: onFirst(PrefixSchema, 'state.list(prefix?): prefix must be a string', (prefix) => state.list(prefix)),
      },
    },
  };
}
