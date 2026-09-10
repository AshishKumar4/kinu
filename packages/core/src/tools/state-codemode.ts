import * as v from 'valibot';
import type { CodemodeProvider } from './sandbox-contract';
import { KeySchema, type ProgramStateStore } from '../identity/program-state';
import { JsonValueSchema } from '../utils/json';
import { KinuError, refusalOf } from '../obs/error';

export const STATE_NAMESPACE = 'state';
const PrefixSchema = v.optional(v.string());

export const STATE_TYPES = `type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };
export declare const state: {
  get(key: string): Promise<StateValue>;
  set(key: string, value: StateValue): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true }>;
  list(prefix?: string): Promise<string[]>;
};`;

export function createStateCodemodeProvider(state: ProgramStateStore): CodemodeProvider {
  return {
    name: STATE_NAMESPACE, types: STATE_TYPES, positionalArgs: true,
    tools: {
      get: {
        planAllowed: true, description: 'Read a saved JSON value; null when absent.',
        execute: async (...args) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return refusalOf(new KinuError('bad_input', 'state.get(key): key must be a non-empty string'));
          return state.get(key.output);
        },
      },
      set: {
        planAllowed: true, description: 'Save a JSON value under a key.',
        execute: async (...args) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return refusalOf(new KinuError('bad_input', 'state.set(key, value): key must be a non-empty string'));
          const value = v.safeParse(JsonValueSchema, args[1] === undefined ? null : args[1]);
          if (!value.success) return refusalOf(new KinuError('bad_input', 'state.set(key, value): value must be JSON-serializable'));
          state.set(key.output, value.output);
          return { ok: true };
        },
      },
      delete: {
        planAllowed: true, description: 'Remove a saved key.',
        execute: async (...args) => {
          const key = v.safeParse(KeySchema, args[0]);
          if (!key.success) return refusalOf(new KinuError('bad_input', 'state.delete(key): key must be a non-empty string'));
          state.delete(key.output);
          return { ok: true };
        },
      },
      list: {
        planAllowed: true, description: 'List saved keys, optionally under a prefix.',
        execute: async (...args) => {
          const prefix = v.safeParse(PrefixSchema, args[0]);
          if (!prefix.success) return refusalOf(new KinuError('bad_input', 'state.list(prefix?): prefix must be a string'));
          return state.list(prefix.output);
        },
      },
    },
  };
}
