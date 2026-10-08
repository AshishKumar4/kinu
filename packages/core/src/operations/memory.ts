/** Durable memory: keyed facts, prose notes, and recall of the agent's past conversations. */
import * as v from 'valibot';
import { JsonValueSchema } from '../utils/json';
import { defineOperation, type Operation } from './operation';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const count = (text: string, max: number) => v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(max)), text));

const Key = described(v.pipe(v.string(), v.nonEmpty()), 'A stable name such as "deploy.target".');

const Query = v.pipe(v.string(), v.nonEmpty());

const ConversationHit = v.strictObject({ conversationId: v.string(), messageId: v.string(), role: v.string(), createdAt: v.number(), snippet: v.string() });

const ConversationMessage = v.strictObject({
  id: v.string(), role: v.string(), content: v.string(), createdAt: v.number(), anchor: v.optional(v.literal(true)),
});

const ConversationSummary = v.strictObject({ conversationId: v.string(), messageCount: v.number(), startedAt: v.number(), lastActiveAt: v.number(), preview: v.string() });

/** A memory operation; a write is planning too, so Plan turns keep it. */
const memoryOp = <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'impact' | 'input' | 'output'>,
) => defineOperation({ ns: 'memory', slate: true, plan: true, ...op });

export const MEMORY = {
  remember: memoryOp({
    name: 'remember',
    help: 'Store a fact under a stable key; an existing key gets the new value.',
    impact: 'mutate',
    // Clamped into 0-1, as the facts store clamps it, so a percentage saves as certain rather than being refused.
    input: v.strictObject({ key: Key, value: described(JsonValueSchema, 'Any JSON value.'), confidence: v.optional(v.pipe(v.number(), v.description('From 0 to 1; default 1.'), v.transform((n) => Math.min(1, Math.max(0, n))))) }),
    output: v.strictObject({ key: described(v.string(), 'The key as stored.') }),
  }),
  recall: memoryOp({
    name: 'recall',
    help: 'A fact by its key; null when none is stored.',
    impact: 'observe',
    input: v.strictObject({ key: Key }),
    output: v.nullable(v.strictObject({ key: v.string(), value: JsonValueSchema, confidence: v.number(), source: v.string(), lastObservedAt: v.number() })),
  }),
  forget: memoryOp({
    name: 'forget',
    help: 'Drop a fact.',
    impact: 'mutate',
    input: v.strictObject({ key: Key }),
    output: v.strictObject({ key: v.string(), existed: v.boolean() }),
  }),
  note: memoryOp({
    name: 'note',
    help: 'Save a prose note or lesson too long to be a fact.',
    impact: 'mutate',
    input: v.strictObject({ content: v.pipe(v.string(), v.nonEmpty()) }),
    output: v.strictObject({ saved: v.literal(true) }),
  }),
  search: memoryOp({
    name: 'search',
    help: 'Notes, and facts by key or value, ranked for a query.',
    impact: 'observe',
    input: v.strictObject({ query: Query }),
    output: v.strictObject({
      semantic: described(v.boolean(), 'false: lexical matching only, semantic recall is unavailable.'),
      hits: v.array(v.strictObject({ ref: described(v.string(), 'A note\'s file and lines, or "fact: <key>".'), text: v.string(), score: v.number() })),
    }),
  }),
  searchConversations: memoryOp({
    name: 'searchConversations',
    help: 'Messages from your past conversations where every query term matches; read around one with readConversation.',
    impact: 'observe',
    input: v.strictObject({ query: Query, limit: count('Default 5.', 10) }),
    output: v.strictObject({ hits: v.array(ConversationHit) }),
  }),
  readConversation: memoryOp({
    name: 'readConversation',
    help: 'The messages on each side of one message.',
    impact: 'observe',
    input: v.strictObject({
      messageId: v.pipe(v.string(), v.nonEmpty()),
      window: count('Messages each side; default 5.', 20),
      maxChars: v.optional(described(v.pipe(v.number(), v.integer(), v.minValue(1)), 'Characters per message; default 700.')),
    }),
    output: v.strictObject({ conversationId: v.string(), messages: v.array(ConversationMessage), messagesBefore: v.number(), messagesAfter: v.number() }),
  }),
  listConversations: memoryOp({
    name: 'listConversations',
    help: 'Your archived conversations, newest first.',
    impact: 'observe',
    input: v.strictObject({ limit: count('Default 10.', 20) }),
    output: v.strictObject({ conversations: v.array(ConversationSummary) }),
  }),
} as const;
