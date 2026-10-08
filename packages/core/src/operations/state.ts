/** A program's own saved JSON values, by key: what one eval run leaves for the next. */
import * as v from 'valibot';
import { KeySchema } from '../identity/program-state';
import { JsonValueSchema } from '../utils/json';
import { defineOperation, type Operation } from './operation';

const Key = v.pipe(KeySchema, v.description('A non-empty key of at most 512 characters.'));

/** Program state is scratch for programs, so Plan turns keep all of it. */
const stateOp = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'impact' | 'input' | 'output'>,
) => defineOperation({ ns: 'state', slate: false, plan: true, ...op });

export const STATE = {
  get: stateOp({
    name: 'get', help: 'A saved JSON value; null when absent.', impact: 'observe',
    input: v.strictObject({ key: Key }), output: JsonValueSchema,
  }),
  set: stateOp({
    name: 'set', help: 'Save a JSON value under a key.', impact: 'mutate',
    input: v.strictObject({ key: Key, value: JsonValueSchema }), output: v.null(),
  }),
  delete: stateOp({
    name: 'delete', help: 'Remove a saved key.', impact: 'mutate',
    input: v.strictObject({ key: Key }), output: v.null(),
  }),
  list: stateOp({
    name: 'list', help: 'The saved keys, under a prefix when given.', impact: 'observe',
    input: v.strictObject({ prefix: v.optional(v.string()) }), output: v.array(v.string()),
  }),
} as const;
