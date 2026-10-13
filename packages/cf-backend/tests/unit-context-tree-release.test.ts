/**
 * An agent's context lives in its own isolate, and its workspace reads it through a tree that isolate serves. Across
 * isolates that tree is a stub, which keeps both ends up until it is let go: a Files listing of /context left one open,
 * and its workspace never hibernated (cmp-kinu-ux4, 2026-10-13). Every read lets its tree go once answered.
 */
import { expect, test } from 'bun:test';
import { gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import { contextTreesHeld } from './helpers/agent-facets';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

test("reading an agent's context through its workspace leaves none of its trees open", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Noted.')));
  const { storageKey } = workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId);

  const listed = await workspace.agent.getExecutorFiles('workspace', '/context');
  const root = await workspace.agent.getExecutorFiles('workspace', '/');

  expect(listed.error).toBeUndefined();
  expect(listed.entries?.length ?? 0).toBeGreaterThan(0);
  expect(root.entries?.map((entry) => entry.name)).toContain('context');
  expect(contextTreesHeld(storageKey)).toBe(0);
});
