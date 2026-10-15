/**
 * The Files tab opens on the workspace's root, whose namespace is a machine's too: Nimbus seeds `bin`, `etc`, `usr`…
 * and mounts `/proc` and `/dev` there. The owner saw those beside the workspace's places (2026-10-14).
 */
import { expect, test } from 'bun:test';
import { gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

test("the workspace's Files root lists its places, not the machine's directories", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Noted.')));

  const root = await workspace.agent.getExecutorFiles('workspace', '/');
  const names = root.entries?.map((entry) => entry.name) ?? [];

  expect(root.error).toBeUndefined();
  expect(names).toEqual(expect.arrayContaining(['home', 'context', 'slates']));
  expect(names.filter((name) => ['bin', 'dev', 'etc', 'opt', 'proc', 'tmp', 'usr', 'var'].includes(name))).toEqual([]);
});
