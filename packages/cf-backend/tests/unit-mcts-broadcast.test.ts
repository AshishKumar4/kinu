/**
 * broadcastMctsProgress pushes the tree of the search that raised the event,
 * and only when that search's tree changed (per search, so a quiet one cannot mask another).
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent, workspaceMainActor } from './helpers/actor-harness';
import { present } from '@kinu.run/test-utils';

const BroadcastSchema = v.object({
  type: v.literal('mcts-progress'),
  rootId: v.string(),
  isolateGen: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  pushSeq: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  phase: v.string(),
  nodeCount: v.number(),
  nodes: v.array(v.object({
    id: v.string(),
    task: v.string(),
    observation: v.string(),
  })),
  head: v.nullable(v.object({
    rootId: v.string(),
    heads: v.array(v.object({
      id: v.string(),
      task: v.string(),
      rationale: v.string(),
      summary: v.nullable(v.string()),
      errorMessage: v.nullable(v.string()),
    })),
  })),
});

type Broadcast = v.InferOutput<typeof BroadcastSchema>;

type OrchestratorHarness = ActorHarness<HarnessOrchestratorAgent>;

function captureBroadcasts(agent: HarnessOrchestratorAgent): Broadcast[] {
  const sent: Broadcast[] = [];
  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => {
      const parsed = v.safeParse(BroadcastSchema, JSON.parse(payload));

      if (parsed.success) sent.push(parsed.output);
    },
  });

  return sent;
}

function seedNode(
  harness: OrchestratorHarness,
  node: {
    id: string; root: string; parent?: string | null; depth?: number; visits?: number; at: number;
    task?: string; observation?: string;
  },
): void {
  // Seed under the handle the agent reads back with; another handle's scoped read answers nothing.
  harness.db.prepare(
    `INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, action, observation, code_used, depth, visits, value, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'action', ?, NULL, ?, ?, 0.5, 'open', ?)`,
  ).run(
    workspaceMainActor(harness.db).actorId,
    node.id,
    node.parent ?? null,
    node.root,
    node.task ?? 'task',
    node.observation ?? 'observation',
    node.depth ?? 0,
    node.visits ?? 1,
    node.at,
  );
}

describe('broadcastMctsProgress', () => {
  test('pushes the named search, never the pile of settled ones beside it', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'old-root', root: 'old-root', at: 1_000 });
    seedNode(harness, { id: 'old-child', root: 'old-root', parent: 'old-root', depth: 1, at: 1_100 });
    seedNode(harness, { id: 'new-root', root: 'new-root', at: 9_000 });

    harness.agent.broadcastMctsProgress('new-root', 'explore', 1, 5);

    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe('mcts-progress');
    expect(sent[0].rootId).toBe('new-root');
    expect(sent[0].nodes.map((n) => n.id)).toEqual(['new-root']);
  });

  test('carries proposal text and a running journal node before settlement', async () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);
    seedNode(harness, {
      id: 'root',
      root: 'root',
      at: 1_000,
      task: 'Find the latency regression',
      observation: 'Start with the service trace.',
    });

    await harness.agent.headJournalRecordSplit('root', 'Investigate the candidate path.', 1_010);
    await harness.agent.headJournalInsertSpawn({
      id: 'running-node',
      rootId: 'root',
      parentId: 'root',
      depth: 1,
      task: 'Compare the two recent traces',
      rationale: 'The branch is still collecting the missing observation.',
      mode: 'build',
      inheritedContext: [],
      budget: { maxDepth: 0, spawnedAt: 1_020 },
      loop: { kind: 'inherit' },
      mergeStrategy: 'synthesize',
    });

    const latest = present(sent.at(-1), 'the latest broadcast');
    expect(latest.pushSeq).toBe(2);
    expect(latest.nodes).toEqual([{
      id: 'root',
      task: 'Find the latency regression',
      observation: 'Start with the service trace.',
    }]);
    expect(latest.head).toMatchObject({
      rootId: 'root',
      heads: [{
        id: 'running-node',
        task: 'Compare the two recent traces',
        rationale: 'The branch is still collecting the missing observation.',
        summary: null,
        errorMessage: null,
      }],
    });
  });

  test('a grown tree is pushed; an unchanged one is not re-sent', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'root', root: 'root', at: 1_000 });
    harness.agent.broadcastMctsProgress('root', 'explore', 1, 3);
    expect(sent.length).toBe(1);

    harness.agent.broadcastMctsProgress('root', 'evaluate', 1, 3);
    expect(sent.length).toBe(1);

    seedNode(harness, { id: 'branch', root: 'root', parent: 'root', depth: 1, at: 1_200 });
    harness.agent.broadcastMctsProgress('root', 'evaluate', 1, 3);
    expect(sent.length).toBe(2);
    expect(sent[1].nodes.map((n) => n.id)).toEqual(['root', 'branch']);

        // Backpropagation changes visits without adding a node — still a change.
    harness.db.prepare(`UPDATE search_nodes SET visits = 4 WHERE id = 'root'`).run();
    harness.agent.broadcastMctsProgress('root', 'iteration-complete', 1, 2);
    expect(sent.length).toBe(3);
    expect(sent[2].nodeCount).toBe(2);
  });

  /** Two concurrent searches: each broadcast must carry its own search's tree. */
  test('two concurrent searches each broadcast their own tree', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'a', root: 'a', at: 1_000 });
    harness.agent.broadcastMctsProgress('a', 'explore', 1, 5);
    expect(present(sent.at(-1), 'the latest broadcast').nodes.map((n) => n.id)).toEqual(['a']);

    seedNode(harness, { id: 'b', root: 'b', at: 2_000 });
    seedNode(harness, { id: 'b1', root: 'b', parent: 'b', depth: 1, at: 2_100 });
    harness.agent.broadcastMctsProgress('b', 'explore', 1, 9);
    expect(present(sent.at(-1), 'the latest broadcast').nodes.map((n) => n.id)).toEqual(['b', 'b1']);

    harness.db.prepare(`UPDATE search_nodes SET visits = 7 WHERE id = 'a'`).run();
    harness.agent.broadcastMctsProgress('a', 'iteration-complete', 1, 4);
    expect(present(sent.at(-1), 'the latest broadcast').rootId).toBe('a');
    expect(present(sent.at(-1), 'the latest broadcast').nodes.map((n) => n.id)).toEqual(['a']);

    seedNode(harness, { id: 'b2', root: 'b', parent: 'b', depth: 1, at: 2_200 });
    harness.agent.broadcastMctsProgress('b', 'evaluate', 2, 8);
    expect(present(sent.at(-1), 'the latest broadcast').rootId).toBe('b');
    expect(present(sent.at(-1), 'the latest broadcast').nodes.map((n) => n.id)).toEqual(['b', 'b1', 'b2']);

    expect(sent.map(({ rootId, pushSeq }) => [rootId, pushSeq])).toEqual([
      ['a', 1],
      ['b', 1],
      ['a', 2],
      ['b', 2],
    ]);

    expect(sent.map(({ isolateGen }) => isolateGen)).toEqual([
      sent[0].isolateGen,
      sent[0].isolateGen,
      sent[0].isolateGen,
      sent[0].isolateGen,
    ]);
  });

  test('the unchanged-tree skip is per search, not one shared scalar', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'a', root: 'a', at: 1_000 });
    seedNode(harness, { id: 'b', root: 'b', at: 2_000 });
    harness.agent.broadcastMctsProgress('a', 'explore', 1, 5);
    harness.agent.broadcastMctsProgress('b', 'explore', 1, 5);
    expect(sent.length).toBe(2);

    harness.agent.broadcastMctsProgress('a', 'evaluate', 1, 5);
    harness.agent.broadcastMctsProgress('b', 'evaluate', 1, 5);
    expect(sent.length).toBe(2);

    seedNode(harness, { id: 'a1', root: 'a', parent: 'a', depth: 1, at: 3_000 });
    harness.agent.broadcastMctsProgress('a', 'evaluate', 1, 4);
    expect(sent.length).toBe(3);
    expect(sent[2].rootId).toBe('a');
    expect(sent[2].nodes.map((n) => n.id)).toEqual(['a', 'a1']);
  });

  test('a search with no nodes yet broadcasts nothing rather than an empty tree', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);
    harness.agent.broadcastMctsProgress('not-yet-rooted', 'explore', 1, 5);
    // Explicit empty keeps the per-search fingerprint from having to encode "no tree".
    expect(sent.length).toBe(0);
  });
});
