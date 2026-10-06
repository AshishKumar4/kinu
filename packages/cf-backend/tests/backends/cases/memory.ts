/** Sleep-time compute: a settled conversation compresses into the actor's facts on the lane's cadence. */
import { expect } from 'bun:test';
import type { ActorHandle, SqlExecutor } from '@kinu.run/core';
import type { SharedCase } from '../cases';

const ONE_FACT = { upserts: [{ key: 'user.editor', value: 'helix', confidence: 0.9, rationale: 'said so' }], decay: [] };

function facts(sql: SqlExecutor, actor: ActorHandle): { key: string; value: string }[] {
  return sql<{ key: string; value: string }>`SELECT key, value_json AS value FROM agent_facts WHERE actor_id = ${actor.actorId} ORDER BY key`;
}

export const MEMORY_CASES: readonly SharedCase[] = [
  {
    title: 'the third completed turn compresses the conversation into facts, never the first two',
    covers: [],
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
    covers: [],
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
