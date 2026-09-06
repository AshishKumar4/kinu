import { describe, expect, test } from 'bun:test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs';
import { HeadJournal } from '../src/heads/journal';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store';
import { initSearchTables } from '../src/mcts/schemas';
import { resolveSwarm } from '../src/strategy/swarm';
import { runSwarm } from '../src/strategy/swarm-run';
import { initSwarmNodeRecords, reenterSwarm } from '../src/strategy/swarm-resume';
import { planLevel, resumedWaves } from '../src/strategy/swarm-level';
import { branchPrompt } from '../src/strategy/swarm-expansion';

const TASK = 'Find the two independent causes of stale coupon reads';
const BRIEFS = [
  { task: 'Inspect cache invalidation', prompt: 'Trace the revision across a credential rotation' },
  { task: 'Inspect transaction visibility', prompt: 'Read the committed row after reconnecting' },
];

function resolved() {
  const value = resolveSwarm({ preset: 'ideate', task: TASK, nodes: BRIEFS });
  if ('reason' in value) throw new Error(value.error);
  return value;
}

function model() {
  return scriptedTurnModel({
    provider: 'fake', modelId: 'brief-reentry',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'The revision changes before the next read.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe('a node keeps its assigned question across re-entry', () => {
  test('the durable node list names each question instead of repeating the run task', async () => {
    const { rt } = createTestRuntime();
    const result = await runSwarm({ rt, model: model(), mode: 'build', logger: createRecordingLogger() }, resolved());
    if ('reason' in result) throw new Error(result.error);
    const journal = new HeadJournal(rt.storage.sql);
    const run = journal.listRuns(1)[0];
    if (!run) throw new Error('The swarm left no run to inspect');
    expect(run.heads.map((head) => head.task).sort()).toEqual(BRIEFS.map((brief) => brief.task).sort());
    expect(run.heads.map((head) => head.rationale).sort()).toEqual(BRIEFS.map((brief) => brief.prompt).sort());
  });

  test('a deep pending node receives its original brief and its settled sibling brief', () => {
    const { rt } = createTestRuntime();
    const sql = rt.storage.sql;
    initSearchTables(rt.storage.execRaw);
    initMctsSearchTable(rt.storage.execRaw);
    initSwarmNodeRecords(rt.storage.execRaw);
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    ledger.begin({
      rootId: 'root', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 6, branches: 2, mode: 'build', maxDepth: 3 }, budget: 6, now: 1,
    });
    void sql`INSERT INTO search_nodes (id, root_id, task, observation) VALUES ('root', 'root', ${TASK}, '')`;
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, depth, task, observation)
      VALUES ('parent', 'root', 'root', 1, ${TASK}, 'parent result')`;
    for (const [index, brief] of BRIEFS.entries()) {
      journal.insertSpawn({
        id: `child-${index}`, rootId: 'root', parentId: 'parent', depth: 2,
        task: brief.task, rationale: brief.prompt, mode: 'build', inheritedContext: [],
        budget: { maxDepth: 1, spawnedAt: 2 }, mergeStrategy: 'synthesize',
      });
    }
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, depth, task, observation)
      VALUES ('child-0', 'parent', 'root', 2, 'Inspect cache invalidation', 'settled result')`;
    const reentry = reenterSwarm({ sql, ledger, journal }, { task: TASK, now: 3 });
    const wave = resumedWaves(reentry)[0];
    if (!wave) throw new Error('The unfinished level was lost');
    const config = resolved();
    const slots = planLevel({ resolved: config, resumed: wave, grant: null, width: wave.siblings });
    const slot = slots[0];
    if (!slot) throw new Error('The unfinished node was lost');
    const prompt = branchPrompt({
      resolved: config, mode: 'build', languages: ['javascript'], measured: null, baseline: null,
      index: slot.index, branches: wave.siblings, task: slot.task, inherited: null,
      aggregated: [], ancestors: [], atDepth: 2, maxDepth: 3, carried: null,
      invite: false, assignment: slot.assignment,
    });
    expect(slot.id).toBe('child-1');
    expect(prompt.user).toContain('Inspect transaction visibility');
    expect(prompt.user).toContain('Your angle: Read the committed row after reconnecting.');
    expect(prompt.user).toContain('Trace the revision across a credential rotation');
  });
});
