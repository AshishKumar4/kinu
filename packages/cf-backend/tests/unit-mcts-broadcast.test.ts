/**
 * broadcastMctsProgress — what a connected client actually receives while a
 * search runs.
 *
 * On a real actor:
 *   - it pushes the tree of the search that RAISED the event. Every settled
 *     search stays in search_nodes forever, and pushing the whole table let the
 *     client root the render at whichever tree it happened to pick — in practice
 *     the workspace's first search, for the rest of the workspace's life. The
 *     fix for that read "the latest tree", which is right for one search and a
 *     coin flip for two concurrent ones.
 *   - it pushes only when THAT search's tree changed. Several events fire per
 *     iteration and each carries the whole tree, observations included; the
 *     receiver already discards an identical payload, so re-serializing and
 *     fanning it out buys nothing. The skip is per search, so a quiet search
 *     cannot mask a growing one.
 */

import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { orchestratorHarness } from './helpers/actor-harness';

interface Broadcast {
  type: string; rootId: string; phase: string;
  nodeCount: number; nodes: Array<{ id: string }>;
}
const BroadcastSchema = v.object({
  type: v.string(),
  rootId: v.string(),
  phase: v.string(),
  nodeCount: v.number(),
  nodes: v.array(v.object({ id: v.string() })),
});

function captureBroadcasts(agent: ReturnType<typeof orchestratorHarness>['agent']): Broadcast[] {
  const sent: Broadcast[] = [];
  Object.defineProperty(agent, 'broadcast', {
    configurable: true,
    value: (payload: string) => { sent.push(v.parse(BroadcastSchema, JSON.parse(payload))); },
  });
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
  test('pushes the named search, never the pile of settled ones beside it', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'old-root', root: 'old-root', at: 1_000 });
    seedNode(harness, { id: 'old-child', root: 'old-root', parent: 'old-root', depth: 1, at: 1_100 });
    seedNode(harness, { id: 'new-root', root: 'new-root', at: 9_000 });

    harness.agent.broadcastMctsProgress('new-root', 'explore', 1, 5);

    expect(sent.length).toBe(1);
    expect(sent[0]!.type).toBe('mcts-progress');
    expect(sent[0]!.rootId).toBe('new-root');
    expect(sent[0]!.nodes.map((n) => n.id)).toEqual(['new-root']);
  });

  test('a grown tree is pushed; an unchanged one is not re-sent', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'root', root: 'root', at: 1_000 });
    harness.agent.broadcastMctsProgress('root', 'explore', 1, 3);
    expect(sent.length).toBe(1);

    // Same tree, next phase of the same iteration — nothing new to render.
    harness.agent.broadcastMctsProgress('root', 'evaluate', 1, 3);
    expect(sent.length).toBe(1);

    // A branch lands: the tree grew, so the client hears about it.
    seedNode(harness, { id: 'branch', root: 'root', parent: 'root', depth: 1, at: 1_200 });
    harness.agent.broadcastMctsProgress('root', 'evaluate', 1, 3);
    expect(sent.length).toBe(2);
    expect(sent[1]!.nodes.map((n) => n.id)).toEqual(['root', 'branch']);

    // Backpropagation changes visits without adding a node — still a change.
    harness.db.prepare(`UPDATE search_nodes SET visits = 4 WHERE id = 'root'`).run();
    harness.agent.broadcastMctsProgress('root', 'iteration-complete', 1, 2);
    expect(sent.length).toBe(3);
    expect(sent[2]!.nodeCount).toBe(2);
  });

  /**
   * TWO SEARCHES AT ONCE — the shape the owner hit ("multiple simultaneously
   * running exploration runs being funky").
   *
   * A broadcast belongs to the search that raised it. Reading "the latest
   * tree" instead means the payload is whichever root was written to most
   * recently, so with two live searches every event is a coin flip: B's
   * iteration ships A's nodes under B's phase and budget, and A's own
   * backpropagation — which UPDATEs visits without inserting anything, so it
   * never becomes "latest" — is dropped by the shared fingerprint as a
   * no-change.
   */
  test('two concurrent searches each broadcast their own tree', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'a', root: 'a', at: 1_000 });
    harness.agent.broadcastMctsProgress('a', 'explore', 1, 5);
    expect(sent.at(-1)!.nodes.map((n) => n.id)).toEqual(['a']);

    // B starts and expands. B is now the most recently written root.
    seedNode(harness, { id: 'b', root: 'b', at: 2_000 });
    seedNode(harness, { id: 'b1', root: 'b', parent: 'b', depth: 1, at: 2_100 });
    harness.agent.broadcastMctsProgress('b', 'explore', 1, 9);
    expect(sent.at(-1)!.nodes.map((n) => n.id)).toEqual(['b', 'b1']);

    // A backpropagates. No insert, so A is still not the "latest" root — but
    // this event is A's and must carry A's tree, not B's.
    harness.db.prepare(`UPDATE search_nodes SET visits = 7 WHERE id = 'a'`).run();
    harness.agent.broadcastMctsProgress('a', 'iteration-complete', 1, 4);
    expect(sent.at(-1)!.rootId).toBe('a');
    expect(sent.at(-1)!.nodes.map((n) => n.id)).toEqual(['a']);

    // And B's next phase is still B's, unaffected by A having spoken between.
    seedNode(harness, { id: 'b2', root: 'b', parent: 'b', depth: 1, at: 2_200 });
    harness.agent.broadcastMctsProgress('b', 'evaluate', 2, 8);
    expect(sent.at(-1)!.rootId).toBe('b');
    expect(sent.at(-1)!.nodes.map((n) => n.id)).toEqual(['b', 'b1', 'b2']);
  });

  /** Change detection is per search: a quiet A must not suppress a growing B,
   *  and a repeat of A's own unchanged tree is still skipped. */
  test('the unchanged-tree skip is per search, not one shared scalar', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);

    seedNode(harness, { id: 'a', root: 'a', at: 1_000 });
    seedNode(harness, { id: 'b', root: 'b', at: 2_000 });
    harness.agent.broadcastMctsProgress('a', 'explore', 1, 5);
    harness.agent.broadcastMctsProgress('b', 'explore', 1, 5);
    expect(sent.length).toBe(2);

    // Neither grew: both repeats are skipped.
    harness.agent.broadcastMctsProgress('a', 'evaluate', 1, 5);
    harness.agent.broadcastMctsProgress('b', 'evaluate', 1, 5);
    expect(sent.length).toBe(2);

    // A grows; B is silent. A's push must not be masked by B's last payload.
    seedNode(harness, { id: 'a1', root: 'a', parent: 'a', depth: 1, at: 3_000 });
    harness.agent.broadcastMctsProgress('a', 'evaluate', 1, 4);
    expect(sent.length).toBe(3);
    expect(sent[2]!.rootId).toBe('a');
    expect(sent[2]!.nodes.map((n) => n.id)).toEqual(['a', 'a1']);
  });

  test('a search with no nodes yet broadcasts nothing rather than an empty tree', () => {
    const harness = orchestratorHarness();
    const sent = captureBroadcasts(harness.agent);
    harness.agent.broadcastMctsProgress('not-yet-rooted', 'explore', 1, 5);
    // An empty projection is not a renderable tree, and saying so explicitly is
    // what keeps the per-search fingerprint from having to encode "no tree".
    expect(sent.length).toBe(0);
  });
});
