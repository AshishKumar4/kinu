// The owner stops one branch head by id (kinu-logs/design/SUBAGENTS.md decision 6); swarm workers are driven through
// the orchestrator in cf-backend's unit-hosted-node-cancel. Defends: a Stop reaching a head that is not running, or
// missing the one that is.
import { expect, test } from 'bun:test';
import { LiveWorkers, liveHead } from '../src/strategy/live-workers';
import type { SpawnedHead } from '../src/heads/controller';
import type { HeadReport } from '../src/heads/types';

test('a branch head is stoppable only while its run is in flight, and its Stop is its own abort', async () => {
  const workers = new LiveWorkers();
  const aborted = Promise.withResolvers<string>();

  const head: SpawnedHead = {
    id: 'h-branch',
    run: async (): Promise<HeadReport> => ({
      id: 'h-branch', status: 'aborted', summary: await aborted.promise, evidence: [], decisions: [], artifactRefs: [],
      fileChanges: [], childHeadIds: [], toolCalls: [], usage: { input: 0, output: 0 }, wallClockMs: 0, stepCount: 0,
    }),
    abort: async (reason) => { aborted.resolve(reason); },
  };

  const hosted = liveHead(workers, head);
  expect(await workers.stop('h-branch', 'stopped by the owner')).toBe(false);

  const running = hosted.run();
  expect(workers.ids()).toEqual(['h-branch']);
  expect(await workers.stop('h-branch', 'stopped by the owner')).toBe(true);
  expect((await running).summary).toBe('stopped by the owner');
  expect(workers.ids()).toEqual([]);
});
