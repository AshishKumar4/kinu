// A share's viewer on the workspace's own (Nimbus) box runs as itself: its own uid, home and `/tmp`, writing none of the
// owner's files, never becoming anyone else, and leaving through an egress that names no owner, so no placeholder it
// finds is ever spent. Real Nimbus under the hosted main actor; requests go to a private address or carry a
// placeholder, so the egress answers them without the network.
import { expect, test } from 'bun:test';
import { withholdingOwnerSecrets } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';
import { EGRESS_FETCHES } from './helpers/programmatic-host';
import { hostedMainActor, orchestratorHarness } from './helpers/actor-harness';

const PLACEHOLDER = `pxs1_${'a'.repeat(43)}`;

async function workspaceShell() {
  const workspace = orchestratorHarness(undefined, { ownerUserId: '0123456789abcdef0123456789abcdef' });
  await workspace.started;
  const shell = present((await hostedMainActor(workspace)).actor.runtime.shell, "main's shell");

  return {
    owner: async (command: string) => await shell.exec(command),
    viewer: async (command: string) => await withholdingOwnerSecrets(() => shell.exec(command)),
  };
}

test("a viewer's command runs as its own uid in its own home, and the owner's as before", async () => {
  const { owner, viewer } = await workspaceShell();
  const own = await owner('id; printf %s "$HOME"');
  const its = await viewer('id; printf %s "$HOME"');

  expect(own.stdout).toStartWith('uid=1000(');
  expect(its.stdout).toEndWith('\n/home/share_viewer');
  expect(its.stdout).not.toContain('1000');
});

test("a viewer writes none of the owner's files and cannot become anyone else, sudo inside a script included", async () => {
  const { owner, viewer } = await workspaceShell();

  // The workspace's own files, where every unnamed call starts (/home/main).
  await owner('printf owner > owned.txt');
  const planted = await viewer('printf viewer > owned.txt; printf viewer > planted.txt');
  const sudo = await viewer('sudo id');
  const nested = await viewer("sh -c 'su root -c id'");

  expect(planted.stderr).toContain('Permission denied');
  expect((await owner('cat owned.txt; test -e planted.txt && echo planted')).stdout).toBe('owner');
  expect(sudo.stderr).toContain("a share's viewer runs only as itself");
  expect(sudo.stdout).not.toContain('uid=0');
  expect(nested.stderr).toContain("a share's viewer runs only as itself");
  expect(nested.stdout).not.toContain('uid=0');
  // The owner's own `sudo` is as it was.
  expect((await owner('sudo id')).stdout).toStartWith('uid=0(');
});

test("a viewer's request, and its child's, leave through an egress naming no owner; the owner's name the owner", async () => {
  const { owner, viewer } = await workspaceShell();
  const before = EGRESS_FETCHES.length;

  await owner('curl -s http://10.0.0.1/owner');
  await viewer('curl -s http://10.0.0.1/viewer');
  await viewer("sh -c 'curl -s http://10.0.0.1/child'");

  expect(EGRESS_FETCHES.slice(before).map(({ url, principal }) => [url, principal])).toEqual([
    ['http://10.0.0.1/owner', 'owner'],
    ['http://10.0.0.1/viewer', 'viewer'],
    ['http://10.0.0.1/child', 'viewer'],
  ]);
});

test('a placeholder a viewer copies is refused at the egress, without asking any vault', async () => {
  const { viewer } = await workspaceShell();
  const answer = await viewer(`curl -s -H "Authorization: Bearer ${PLACEHOLDER}" https://api.stripe.com/v1/charges`);

  expect(answer.stdout).toContain("holds none of the owner's secrets");
});
