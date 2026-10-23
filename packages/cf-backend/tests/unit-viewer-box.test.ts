// A share's viewer on the workspace's own (Nimbus) box runs as itself: its own uid, home and `/tmp`, writing the owner's
// project and none of the owner's other files, never becoming anyone else, and leaving through an egress that names no owner, so no placeholder it
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
    setSoul: async (text: string) => { await workspace.agent.setSoul(text); },
    owner: async (command: string, name?: string) => await shell.exec(command, name === undefined ? {} : { name }),
    viewer: async (command: string, name?: string) => await withholdingOwnerSecrets(() => shell.exec(command, name === undefined ? {} : { name })),
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

test("a viewer writes the owner's project, the owner's files in it included, and nothing else of the owner's", async () => {
  const { setSoul, owner, viewer } = await workspaceShell();
  await setSoul('# Kiln\n\nShip the Worker.');

  // The project, where every unnamed call starts (/home/main): the owner's choice, 2026-10-19, "your project too".
  await owner('mkdir -p src && printf owner > src/owned.txt');
  const wrote = await viewer('printf viewer > src/owned.txt && printf viewer > planted.txt && echo wrote');
  const read = await owner('cat src/owned.txt planted.txt');

  expect(wrote.stdout).toBe('wrote\n');
  expect(read.stdout).toBe('viewerviewer');

  // The workspace's identity, the owner's own state and every other home stay out of the viewer's reach, written,
  // removed, renamed or replaced: the project's root is sticky.
  for (const command of ['printf x >> SOUL.md', 'touch .kinu/planted', 'mkdir /home/planted', 'rm -f SOUL.md', 'mv .kinu .kinu-old', 'mv planted.txt SOUL.md']) {
    expect((await viewer(command)).stderr).toMatch(/Permission denied|Operation not permitted/);
  }

  expect((await owner('test -d .kinu && test -f SOUL.md && test -f planted.txt && echo kept')).stdout).toBe('kept\n');
});

test('a viewer cannot become anyone else, sudo inside a script included', async () => {
  const { owner, viewer } = await workspaceShell();
  const sudo = await viewer('sudo id');
  const nested = await viewer("sh -c 'su root -c id'");

  // Refused where the process would be made (Nimbus's `mayChangeIdentity`), not by the command's name.
  for (const refused of [sudo, nested]) {
    expect(refused.stderr).toContain('EPERM');
    expect(refused.stdout).not.toContain('uid=0');
  }

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

test("a viewer's named shell never resumes the owner's, whatever the owner named theirs", async () => {
  const { owner, viewer } = await workspaceShell();

  // The owner's shell named as the viewer's own `build` would be, were the viewer's names only prefixed.
  await owner('export OWNER_ONLY=owner-marker', 'share_viewer.build');
  await owner('export OWNER_ONLY=owner-marker', 'build');
  await viewer('export VIEWER_ONLY=viewer-marker', 'build');

  expect((await viewer('printf %s "$OWNER_ONLY"', 'build')).stdout).toBe('');
  expect((await viewer('printf %s "$OWNER_ONLY"', 'share_viewer.build')).stdout).toBe('');
  expect((await viewer('printf %s "$VIEWER_ONLY"', 'build')).stdout).toBe('viewer-marker');
  expect((await owner('printf %s "$OWNER_ONLY"', 'share_viewer.build')).stdout).toBe('owner-marker');
  expect((await owner('printf %s "$VIEWER_ONLY"', 'build')).stdout).toBe('');
});

