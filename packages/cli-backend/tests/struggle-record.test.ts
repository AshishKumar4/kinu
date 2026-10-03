/**
 * A tool input its schema refuses is a struggle the turn carries to its review (docs/EVOLUTION-REDESIGN.md §2), through
 * the real tool and steering path, not a hand-fed steering detector.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { setup, toolSequenceModel } from './helpers/local-session';

test('a schema-refused file call is recorded as the turn\'s schema_refusal', async () => {
  const model = toolSequenceModel([{ name: 'file', input: { action: 'read' } }]);
  const { db, session } = setup('unused', model, { noAutoEvolve: false });

  await session.send('read the README', { id: crypto.randomUUID() });
  await session.end();

  const rows = db.query<{ turn: string }, []>('SELECT turn FROM completed_turns').all();
  const struggles = rows.flatMap((row) => v.parse(v.object({ struggles: v.optional(v.array(v.object({ kind: v.string(), tool: v.nullable(v.string()) })), []) }), JSON.parse(row.turn)).struggles);

  expect(struggles.map(({ kind, tool }) => ({ kind, tool }))).toEqual([{ kind: 'schema_refusal', tool: 'file' }]);
});
