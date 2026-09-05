/**
 * A hosted subordinate gets a home on the workspace it is hired into, runs as
 * it, and gives it back when it is wiped.
 *
 * Through the production seams and against the real substrate: the child is
 * seeded by `setSubordinateIdentity`, which asks the WORKSPACE for its home;
 * the workspace provisions it in its own isolate over the same three members
 * the local backend hands core's one provisioner; the child's runtime carries
 * the credential on both planes; and `dismissSubordinate` releases the home
 * with the storage on a wipe, and keeps both on an archive.
 */
import { describe, expect, test } from 'bun:test';
import { agentHome, agentTmpRoot, subordinateAgentName } from '@kinu.run/core';
import { hiredSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const hire = {
  displayName: 'Builder',
  nameOrigin: 'user' as const,
  role: 'builds things',
  mission: 'build the thing',
};

describe('a hosted subordinate runs as its own home', () => {
  test('seeding provisions the home on the workspace and the runtime acts as that uid', async () => {
    const parent = orchestratorHarness();
    const child = await hiredSubordinateHarness(parent, { ...hire, name: 'builder-1' });
    const agentName = subordinateAgentName('builder-1');

    const home = await parent.agent.statWorkspaceFile(agentHome(agentName));
    expect(home).toMatchObject({ ok: true, value: expect.objectContaining({ isDir: true }) });
    // The shell carries the facet's own home and scratch — two of the three
    // facts a node rebuilds from; the third, the credential, is what the
    // refused write below proves.
    const shell = child.agent.observeRuntime().shell;
    if (!shell) throw new Error('a hosted subordinate runtime carries a shell');
    const identity = await shell.exec('printf "%s %s" "$HOME" "$TMPDIR"');
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.split(' ')).toEqual([agentHome(agentName), agentTmpRoot(agentName)]);
    // Its file tools act as the same uid: a write in its home lands, a write
    // in the origin's tree is refused.
    await child.agent.observeRuntime().storage.vfs.writeFile(`${agentHome(agentName)}/notes.md`, 'mine');
    await expect(child.agent.observeRuntime().storage.vfs.writeFile('/home/user/theirs.md', 'x'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    // And a bare `/tmp` is private: the origin sees nothing at the shared path.
    expect((await shell.exec('echo s > /tmp/x')).exitCode).toBe(0);
    expect(await parent.agent.statWorkspaceFile('/tmp/x')).toMatchObject({ ok: true, value: null });
  });

  test('a wipe releases the home with the storage; an archive keeps both', async () => {
    const parent = orchestratorHarness();
    await hiredSubordinateHarness(parent, { ...hire, name: 'builder-2' });
    const agentName = subordinateAgentName('builder-2');
    const directory = { ok: true, value: expect.objectContaining({ isDir: true }) };
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(directory);

    // An archive keeps the rows readable, and the tree with them.
    await parent.agent.observeSubordinateRuntime().dismiss('builder-2', true);
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(directory);

    // A wipe takes the home and the scratch with the storage.
    await parent.agent.observeSubordinateRuntime().dismiss('builder-2', false);
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject({ ok: true, value: null });
    expect(await parent.agent.statWorkspaceFile(agentTmpRoot(agentName))).toMatchObject({ ok: true, value: null });
  });
});
