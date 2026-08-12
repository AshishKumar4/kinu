/**
 * broadcastMctsProgress — what a connected client actually receives while a
 * search runs.
 *
 * Two properties, on a real actor:
 *   - it pushes the LATEST search only. Every settled search stays in
 *     search_nodes forever, and pushing the whole table let the client root
 *     the render at whichever tree it happened to pick — in practice the
 *     workspace's first search, for the rest of the workspace's life.
 *   - it pushes only when the tree CHANGED. Several progress events fire per
 *     iteration and each carries the whole tree, observations included; the
 *     receiver already discards an identical payload, so re-serializing and
 *     fanning it out buys nothing.
 */

import { describe, test, expect } from 'bun:test';
import { orchestratorHarness } from './helpers/actor-harness.js';

interface Broadcast { type: string; phase: string; nodeCount: number; nodes: Array<{ id: string }> }

function captureBroadcasts(agent: object): Broadcast[] {
  const sent: Broadcast[] = [];
  (agent as { broadcast: (payload: string) => void }).broadcast = (payload: string) => {
    sent.push(JSON.parse(payload) as Broadcast);
  };
  return sent;
}

function seedNode(
  harness: ReturnType<typeof orchestratorHarness>,
  node: { id: string; root: string; parent?: string | null; depth?: number; visits?: number; at: number },
): void {
  harness.db.prepare(
    `INSERT INTO search_nodes (id, parent_id, root_id, task, action, observation, code_used, depth, visits, value, status, created_at)
     VALUES (?, ?, ?, 'task', 'action', 'observation', NULL, ?, ?, 0.5, 'open', ?)`,
  ).run(node.id, node.parent ?? null, node.root, node.depth ?? 0, node.visits ?? 1, node.at);
}

describe('broadcastMctsProgress', () => {
  test('pushes the latest search, never the pile of settled ones', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'old-root', root: 'old-root', at: 1_000 });
    seedNode(harness, { id: 'old-child', root: 'old-root', parent: 'old-root', depth: 1, at: 1_100 });
    seedNode(harness, { id: 'new-root', root: 'new-root', at: 9_000 });

    harness.agent.broadcastMctsProgress('explore', 1, 5);

    expect(sent.length).toBe(1);
    expect(sent[0]!.type).toBe('mcts-progress');
    expect(sent[0]!.nodes.map((n) => n.id)).toEqual(['new-root']);
  });

  test('a grown tree is pushed; an unchanged one is not re-sent', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'root', root: 'root', at: 1_000 });
    harness.agent.broadcastMctsProgress('explore', 1, 3);
    expect(sent.length).toBe(1);

    // Same tree, next phase of the same iteration — nothing new to render.
    harness.agent.broadcastMctsProgress('evaluate', 1, 3);
    expect(sent.length).toBe(1);

    // A branch lands: the tree grew, so the client hears about it.
    seedNode(harness, { id: 'branch', root: 'root', parent: 'root', depth: 1, at: 1_200 });
    harness.agent.broadcastMctsProgress('evaluate', 1, 3);
    expect(sent.length).toBe(2);
    expect(sent[1]!.nodes.map((n) => n.id)).toEqual(['root', 'branch']);

    // Backpropagation changes visits without adding a node — still a change.
    harness.db.prepare(`UPDATE search_nodes SET visits = 4 WHERE id = 'root'`).run();
    harness.agent.broadcastMctsProgress('iteration-complete', 1, 2);
    expect(sent.length).toBe(3);
    expect(sent[2]!.nodeCount).toBe(2);
  });

  test('an empty search table broadcasts nothing rather than an empty tree', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);
    harness.agent.broadcastMctsProgress('explore', 1, 5);
    // Nothing has ever been pushed, and the fingerprint of "no tree" matches
    // the initial state, so the first real node is what a client first sees.
    expect(sent.length).toBe(0);
  });
});
