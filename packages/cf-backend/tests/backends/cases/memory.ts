/** Sleep-time compute: a settled conversation compresses into the actor's facts on the lane's cadence. */
import { expect } from 'bun:test';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { CHAT_SESSION_ID, chatSeed, createFactsStore, keptMediaName, type ActorHandle, type SqlExecutor } from '@kinu.run/core';
import type { ScriptedTurnResult } from '@kinu.run/test-utils';
import type { SharedCase } from '../cases';

const ONE_FACT = { upserts: [{ key: 'user.editor', value: 'helix', confidence: 0.9, rationale: 'said so' }], decay: [] };

function facts(sql: SqlExecutor, actor: ActorHandle): { key: string; value: string }[] {
  return sql<{ key: string; value: string }>`SELECT key, value_json AS value FROM agent_facts WHERE actor_id = ${actor.actorId} ORDER BY key`;
}

/** An OpenAI project key, assembled so no source holds one. */
const KEY = ['sk', 'proj', 'Q7r2W9x4'.repeat(4)].join('-');

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** The main model's step that calls `tool` with `input`. */
function called(tool: string, input: Record<string, string>): ScriptedTurnResult {
  return { content: [{ type: 'tool-call', toolCallId: `call-${crypto.randomUUID()}`, toolName: tool, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE, warnings: [] };
}

/** How many rows of each memory store hold `text`: the stores sit beside the workspace's agent, the conversation's
 *  index beside its chat. The notes' index keeps terms alone, so it is asked for the key's body as a term. */
function holding(stores: SqlExecutor, chat: SqlExecutor, text: string) {
  const like = `%${text}%`;
  const count = (rows: readonly { readonly n: number }[]): number => rows[0]?.n ?? 0;

  return {
    agent_facts: count(stores<{ n: number }>`SELECT COUNT(*) AS n FROM agent_facts WHERE value_json LIKE ${like}`),
    agent_fact_history: count(stores<{ n: number }>`SELECT COUNT(*) AS n FROM agent_fact_history WHERE value_json LIKE ${like}`),
    prepared_outputs: count(stores<{ n: number }>`SELECT COUNT(*) AS n FROM prepared_outputs WHERE output LIKE ${like}`),
    memory_note_chunks_fts: count(stores<{ n: number }>`SELECT COUNT(*) AS n FROM memory_note_chunks_fts WHERE memory_note_chunks_fts MATCH ${`"${text.split('-').at(-1) ?? text}"`}`),
    conversation_fts: count(chat<{ n: number }>`SELECT COUNT(*) AS n FROM conversation_fts WHERE content LIKE ${like}`),
  };
}

/** The memory block a model call was sent last: its step's own, after the blocks of the steps before it, up to the
 *  blank line or the block's end after it. */
function memoryBlockOf(request: string): string {
  const shown = [...request.matchAll(/## World model \(facts you remembered\)\\n([\s\S]*?)\\n(?:\\n|<)/gu)].at(-1)?.[1] ?? '';

  return shown.replaceAll('\\n', '\n');
}

const DAY_MS = 86_400_000;

export const MEMORY_CASES: readonly SharedCase[] = [
  {
    // Roadmap, 2026-10-25: each turn was shown its newest twenty facts whatever it asked, so a fact older than them was
    // never in its block.
    title: "a turn's block holds the old fact and note its words match, dated, before the newest facts, and none of it is kept",
    async run({ surface, answers, sql, actor, history, requests }) {
      // Written before any turn reads them, as a turn's own writes are seen by the next.
      const store = createFactsStore(sql, actor);
      const old = Date.now() - 40 * DAY_MS;

      store.upsert('deploy_region', 'us-east-1');
      store.upsert('deploy_region', 'eu-west-3');
      void sql`UPDATE agent_facts SET last_observed_at = ${old} WHERE actor_id = ${actor.actorId} AND key = 'deploy_region'`;

      for (let index = 0; index < 30; index += 1) store.upsert(`reading_list_${String(index)}`, `chapter ${String(index)} of the parser book, `.repeat(4));

      answers(called('memory', { op: 'note', content: 'We deploy to us-east-1 for now.' }));
      await surface.send('Remember where we deploy.');
      await surface.send('Which region do we deploy to?');

      const block = memoryBlockOf(JSON.stringify(requests().at(-1)?.prompt));
      const lines = block.split('\n');
      const kept = (await chatSeed(history.transcript(CHAT_SESSION_ID), keptMediaName)).messages.flatMap((message) => message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])));

      expect({
        matched: lines.find((line) => line.startsWith('deploy_region:')),
        note: lines.find((line) => line.includes('us-east-1 for now'))?.includes('superseded by fact deploy_region'),
        first: lines.findIndex((line) => line.startsWith('deploy_region:')) < lines.findIndex((line) => line.startsWith('reading_list_')),
        newest: lines.some((line) => line.startsWith('reading_list_')),
        within: block.length <= 2000 + 100,
        kept: kept.some((text) => text.includes('deploy_region') || text.includes('World model')),
      }).toEqual({
        matched: `deploy_region: eu-west-3  # as of ${new Date(old).toISOString().slice(0, 10)}`,
        note: true,
        first: true,
        newest: true,
        within: true,
        kept: false,
      });
    },
  },
  {
    // Roadmap, 2026-10-25: a note, a fact or a sleep-time write kept a secret said in chat as it was said.
    title: 'a key said in chat reaches no note, fact, sleep-time fact or search index, each keeping the kind it was',
    async run({ surface, answers, sleepTime, settled, sql, actor, chat, files, requests }) {
      sleepTime({ upserts: [{ key: 'openai.access', value: `the owner's key is ${KEY}`, confidence: 0.9, rationale: `said ${KEY}` }], decay: [] }, true);
      answers(called('memory', { op: 'note', content: `The owner's OpenAI key is ${KEY}.` }), called('memory', { op: 'remember', key: 'openai_key', value: KEY }));

      for (const ask of [`My OpenAI key is ${KEY}; keep it.`, 'Open the parser.', 'Now the lexer.']) {
        await surface.send(ask);
        await settled();
      }

      answers(called('memory', { op: 'searchConversations', query: 'OpenAI key' }), called('memory', { op: 'search', query: KEY }));
      await surface.send('Where is that key?');
      await settled();

      const note = await readText(files, '/home/main/memory/MEMORY.md');
      const kept = Object.fromEntries(sql<{ key: string; value: string }>`SELECT key, value_json AS value FROM agent_facts WHERE actor_id = ${actor.actorId}`.map((row) => [row.key, row.value]));
      // What the two searches answered, the newest tool results the last call was sent.
      const answered = (requests().at(-1)?.prompt.filter((message) => message.role === 'tool').map((message) => JSON.stringify(message.content)) ?? []).slice(-2);

      expect({
        said: JSON.stringify(requests()[0]?.prompt).includes(KEY),
        note: note.includes('<redacted:provider-secret>') && !note.includes(KEY),
        facts: { openai_key: kept.openai_key, sleeps: kept['openai.access']?.includes('<redacted:provider-secret>') },
        indexed: holding(sql, chat.sql, KEY),
        found: answered.length === 2 && answered.every((result) => !result.includes(KEY)),
      }).toEqual({
        said: true,
        note: true,
        facts: { openai_key: '"<redacted:provider-secret>"', sleeps: true },
        indexed: { agent_facts: 0, agent_fact_history: 0, prepared_outputs: 0, memory_note_chunks_fts: 0, conversation_fts: 0 },
        found: true,
      });
      expect(chat.sql<{ n: number }>`SELECT COUNT(*) AS n FROM conversation_fts WHERE content LIKE '%<redacted:provider-secret>%'`[0]?.n).toBeGreaterThan(0);
    },
  },
  {
    title: 'the third completed turn compresses the conversation into facts, never the first two',
    async run({ surface, sleepTime, settled, sql, actor }) {
      const prompts = sleepTime(ONE_FACT, true);

      for (const ask of ['Use helix for edits.', 'Open the parser.']) {
        await surface.send(ask);
        await settled();
      }

      expect(prompts).toEqual([]);
      await surface.send('Now the lexer.');
      await settled();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('Use helix for edits.');
      expect(facts(sql, actor)).toEqual([{ key: 'user.editor', value: '"helix"' }]);
    },
  },
  {
    title: 'a lane switched off makes no model call and learns nothing',
    async run({ surface, sleepTime, settled, sql, actor }) {
      const prompts = sleepTime(ONE_FACT, false);

      for (const ask of ['Use helix for edits.', 'Open the parser.', 'Now the lexer.']) {
        await surface.send(ask);
        await settled();
      }

      expect(prompts).toEqual([]);
      expect(facts(sql, actor)).toEqual([]);
    },
  },
];
