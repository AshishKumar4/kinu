/**
 * A hosted subordinate gets a home on the workspace it is hired into, runs as
 * it, and gives it back when it is wiped.
 *
 * Through the production seams and against the real substrate: the child is
 * hired through the parent's own `SubordinateRuntime.spawn`, then acquired from
 * the workspace's one `ActorHost`; the host provisions the home in its own
 * isolate over the same members the local backend hands core's one
 * provisioner; the child's runtime carries the credential on both planes; and
 * the roster's dismissal releases the home with the storage on a wipe, and
 * keeps both on an archive.
 */
import { describe, expect, test } from 'bun:test';
import { agentHome, agentTmpRoot, actorReferenceOf, subordinateAgentName } from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const hire = {
  displayName: 'Builder',
  nameOrigin: 'user' as const,
  roleId: 'implementer' as const,
  mission: 'build the thing',
};

describe('a hosted subordinate runs as its own home', () => {
  test('hiring provisions the home on the workspace and the runtime acts as that uid', async () => {
    const parent = orchestratorHarness();
    const child = await hostedSubordinateHarness(parent, { ...hire, name: 'builder-1' });
    const agentName = subordinateAgentName(child.actor.handle.storageKey);

    const home = await parent.agent.statWorkspaceFile(agentHome(agentName));
    expect(home).toMatchObject({ ok: true, value: expect.objectContaining({ isDir: true }) });
    // The shell carries the actor's own home and scratch — two of the three
    // facts a hosted actor rebuilds from; the third, the credential, is what the
    // refused write below proves.
    const shell = child.actor.runtime.shell;
    if (!shell) throw new Error('a hosted subordinate runtime carries a shell');
    const identity = await shell.exec('printf "%s %s" "$HOME" "$TMPDIR"');
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.split(' ')).toEqual([agentHome(agentName), agentTmpRoot(agentName)]);
    // Its file tools act as the same uid: a write in its home lands, a write
    // in the origin's tree is refused.
    await child.actor.runtime.storage.vfs.writeFile(`${agentHome(agentName)}/notes.md`, 'mine');
    await expect(child.actor.runtime.storage.vfs.writeFile('/home/user/theirs.md', 'x'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    // And a bare `/tmp` is private: the origin sees nothing at the shared path.
    expect((await shell.exec('echo s > /tmp/x')).exitCode).toBe(0);
    expect(await parent.agent.statWorkspaceFile('/tmp/x')).toMatchObject({ ok: true, value: null });
  });

  test('a wipe releases the home with the storage; an archive keeps both', async () => {
    const parent = orchestratorHarness();
    const child = await hostedSubordinateHarness(parent, { ...hire, name: 'builder-2' });
    const actor = child.actor.handle;
    const agentName = subordinateAgentName(actor.storageKey);
    const directory = { ok: true, value: expect.objectContaining({ isDir: true }) };
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(directory);

    // An archive keeps the rows readable, and the tree with them.
    await parent.agent.observeSubordinateRuntime().dismiss('builder-2', true, actorReferenceOf(actor));
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(directory);

    // A wipe takes the home and the scratch with the storage.
    await parent.agent.observeSubordinateRuntime().dismiss('builder-2', false, actorReferenceOf(actor));
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject({ ok: true, value: null });
    expect(await parent.agent.statWorkspaceFile(agentTmpRoot(agentName))).toMatchObject({ ok: true, value: null });
  });
});
