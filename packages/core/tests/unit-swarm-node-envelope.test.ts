/**
 * The node envelope's derivation, held against the measurement it came from (sibling of
 * `unit-turn-envelope.test.ts`). No measured node finished, so only the cost of a step is derivable.
 */
import { expect, test, spyOn } from 'bun:test';
import { scriptedTurnModel, unobservedSpend } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { runNodeAgent } from '../src/strategy/node-agent';

/** A node's step can outlast any bound a caller might pick; nothing ends the node but its own stop. */
test('a node finishes after a 26-minute step: nothing times it out', async () => {
  const { rt, db } = createTestRuntime();
  const journal = new HeadJournal(rt.storage.sql, rt.actor);
  const seats = hostedSeatsOver({ rt, db });
  let steps = 0;
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);

  try {
    const run = await runNodeAgent({
      nodeId: 'n-long-step', rootId: 'r-long-step', parentId: null, depth: 0,
      task: 'answer the task', rationale: 'the run asked for it',
      base: 'You are a node under test.',
      messages: [{ role: 'user', content: 'Answer the task.' }],
      inherited: [], context: 'fresh', mode: 'build', settle: 'best', arbitrate: null,
    }, {
      reportModelCall: unobservedSpend,
      hostNode: seats.hostNode,
      model: scriptedTurnModel({
        provider: 'fake', modelId: 'fake-long-step',
        doGenerate: async () => {
          steps++;
          now += 26 * 60_000;

          return {
            content: [{ type: 'text', text: 'finished the long step' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 3, text: 3, reasoning: undefined },
            }, warnings: [],
          };
        },
      }),
      journal, logger: createRecordingLogger(),
    });

    expect(run.report.status).toBe('completed');
    expect(steps).toBe(1);
  } finally {
    clock.mockRestore();
  }
});
