/**
 * A hosted subordinate gets a home on its workspace, runs as it, and gives it back on a wipe
 * (kept on an archive), all through the production seams.
 */
import { describe, expect, test } from 'bun:test';
import { agentHome, agentTmpRoot, actorReferenceOf, subordinateAgentName } from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness } from './helpers/actor-harness';

const hire = {
  displayName: 'Builder',
  nameOrigin: 'user' as const,
  roleId: 'task' as const,
  mission: 'build the thing',
};

describe('a hosted subordinate runs as its own home', () => {
  test('hiring provisions the home on the workspace and the runtime acts as that uid', async () => {
    const parent = orchestratorHarness();
    const child = await hostedSubordinateHarness(parent, { ...hire, name: 'builder-1' });
    const agentName = subordinateAgentName(child.actor.handle.storageKey);

    const home = await parent.agent.statWorkspaceFile(agentHome(agentName));
    expect(home).toMatchObject({ ok: true, value: expect.objectContaining({ isDir: true }) });
    const shell = child.actor.runtime.shell;

    if (!shell) throw new Error('a hosted subordinate runtime carries a shell');
    const identity = await shell.exec('printf "%s %s" "$HOME" "$TMPDIR"');
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.split(' ')).toEqual([agentHome(agentName), agentTmpRoot(agentName)]);
    await child.actor.runtime.storage.vfs.writeFile(`${agentHome(agentName)}/notes.md`, 'mine');
    await expect(child.actor.runtime.storage.vfs.writeFile('/home/user/theirs.md', 'x'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
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

    await parent.agent.observeSubordinateRuntime().dismiss('builder-2', true, actorReferenceOf(actor));
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(directory);

    await parent.agent.observeSubordinateRuntime().dismiss('builder-2', false, actorReferenceOf(actor));
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject({ ok: true, value: null });
    expect(await parent.agent.statWorkspaceFile(agentTmpRoot(agentName))).toMatchObject({ ok: true, value: null });
  });
});
