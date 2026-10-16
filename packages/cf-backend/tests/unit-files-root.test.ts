/**
 * The Files tab opens on the workspace's root, whose namespace is a machine's too: Nimbus seeds `bin`, `etc`, `usr`…
 * and mounts `/proc` and `/dev` there. The owner saw those beside the workspace's places (2026-10-14), and asked for
 * them as a desktop has them: hidden items, there when asked for.
 */
import { expect, test } from 'bun:test';
import { gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const MACHINE = ['bin', 'dev', 'etc', 'opt', 'proc', 'tmp', 'usr', 'var'];

test("the workspace's Files root hides the machine's directories until asked, then marks them", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'Noted.')));

  const root = await workspace.agent.getExecutorFiles('workspace', '/');
  const shown = await workspace.agent.getExecutorFiles('workspace', '/', { hidden: true });
  const names = root.entries?.map((entry) => entry.name) ?? [];

  expect(root.error).toBeUndefined();
  expect(names).toEqual(expect.arrayContaining(['home', 'context', 'slates']));
  expect(names.filter((name) => MACHINE.includes(name))).toEqual([]);
  expect(shown.entries?.filter((entry) => entry.hidden === true).map((entry) => entry.name)).toEqual(expect.arrayContaining(['etc', 'usr', 'tmp']));
});
