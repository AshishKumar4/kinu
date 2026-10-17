/**
 * What the agent did by itself is history, not a request: the owner's Work tab listed "Learned 7 things about your
 * environment" and "Rated 5 turns · 5 by the decision model from the user's reply" under Needs you (2026-10-16),
 * though neither waits on them. Both stay in the Agent tab's journal.
 */
import { expect, test } from 'bun:test';
import { createFactsStore, recordTurnRating } from '@kinu.run/core';
import { wrapDatabase } from '@kinu.run/core/identity';
import { orchestratorHarness, workspaceMainActor } from './helpers/actor-harness';

test('facts it learned and turns it rated ask nothing of the owner, and stay in its journal', async () => {
  const harness = orchestratorHarness();
  const sql = wrapDatabase(harness.db).sql;
  const actor = workspaceMainActor(harness.db);
  const facts = createFactsStore(sql, actor);

  for (let fact = 0; fact < 7; fact++) facts.upsert(`computer.tool_${String(fact)}`, `v${String(fact)}`, { confidence: 0.9, source: 'sleep-time-compute' });

  for (let turn = 0; turn < 5; turn++) {
    recordTurnRating(sql, actor, { turnId: `turn-${String(turn)}`, score: 4, corrected: 0, wrong: null, request: 'q', answer: 'a', source: 'model' });
  }

  expect(await harness.agent.listPendingActions()).toEqual([]);

  const journal = await harness.agent.getEvolutionChangelog();

  expect(journal.entries.map((entry) => entry.summary).sort()).toEqual([
    'Learned 7 things about your environment', 'Rated 5 turns · 5 by the decision model from the user\'s reply',
  ]);
});
