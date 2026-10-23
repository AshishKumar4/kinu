/** Google's own APIs through the account's Google connection: find a method, read its types, call it. */
import * as v from 'valibot';
import { JsonValueSchema } from '../utils/json';
import { defineOperation, described } from './operation';

const Method = described(v.pipe(v.string(), v.nonEmpty()), 'A method id from google.search, as `gmail.users.messages.list`.');

const Params = v.optional(described(v.record(v.string(), JsonValueSchema), 'Its parameters by name, path and query alike: `{ userId: "me", q: "is:unread" }`.'));

const Answer = v.strictObject({ status: v.number(), body: JsonValueSchema });

export const GOOGLE = {
  search: defineOperation({
    ns: 'google', slate: false, name: 'search', help: 'Methods of Gmail, Calendar, Drive, Docs, Sheets, Slides and contacts for what you want to do, best first.', impact: 'observe',
    input: v.strictObject({ query: v.pipe(v.string(), v.nonEmpty()), limit: v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)), 'Default 8.')) }),
    output: v.array(v.strictObject({ id: v.string(), kind: v.picklist(['read', 'write']), d: v.string() })),
    text: (found) => (found.length === 0 ? 'No Google method matches.' : found.map((m) => `${m.id} (${m.kind}): ${m.d}`).join('\n')),
  }),
  describe: defineOperation({
    ns: 'google', slate: false, name: 'describe', help: 'A method as TypeScript, its parameters and the types it takes and answers; or one type, as `gmail.Message`.', impact: 'observe',
    input: v.strictObject({ name: v.pipe(v.string(), v.nonEmpty()) }),
    output: v.string(),
    text: (declaration) => declaration,
  }),
  read: defineOperation({
    ns: 'google', slate: false, name: 'read', help: 'Call a method that reads (GET). Its answer is Google\'s JSON.', impact: 'observe',
    input: v.strictObject({ method: Method, params: Params }),
    output: Answer,
  }),
  write: defineOperation({
    ns: 'google', slate: false, name: 'write',
    help: 'Call a method that sends, changes or deletes something at Google. The owner approves each call first: until then it answers asked, and the same call made again after they approve goes once.',
    impact: 'externalSend', plan: false,
    input: v.strictObject({ method: Method, params: Params, body: v.optional(described(JsonValueSchema, 'The request body, as google.describe gives it.')) }),
    output: v.union([
      v.strictObject({ status: v.literal('asked'), approval: v.string() }),
      v.strictObject({ status: v.literal('denied'), approval: v.string() }),
      v.strictObject({ status: v.literal('done'), answer: Answer }),
    ]),
  }),
} as const;
