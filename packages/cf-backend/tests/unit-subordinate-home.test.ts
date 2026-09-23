/**
 * A hosted subordinate gets a home on its workspace, runs as it, and gives it back on a wipe
 * (kept on an archive), all through the production seams.
 */
import { describe, expect, test } from 'bun:test';
import { agentHome, agentTmpRoot, subordinateAgentName } from '@kinu.run/core';
import { hostedSubordinateHarness, orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** An agent the owner adds takes the workspace's mission, which the soul states. */
const SOUL = '# Kinu\n\n## Mission\n\nBuild the thing.\n';

const DIRECTORY = { ok: true, value: expect.objectContaining({ isDir: true }) };

/** An agent the owner added, as the browser adds one, and the home name its directory row gives it. */
async function addedAgent(): Promise<{ parent: ActorHarness<HarnessOrchestratorAgent>; name: string; agentName: string }> {
  const parent = orchestratorHarness();
  await parent.agent.setSoul(SOUL);
  const { name } = await parent.agent.createSubordinateAgent();

  const row = parent.db.query<{ storage_key: string }, [string]>(
    "SELECT storage_key FROM workspace_actors WHERE name = ? AND kind = 'subordinate'",
  ).get(name);

  if (row === null) throw new Error(`no directory row names ${name}`);

  return { parent, name, agentName: subordinateAgentName(row.storage_key) };
}

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
    await expect(child.actor.runtime.storage.vfs.writeFile('/home/main/theirs.md', 'x'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect((await shell.exec('echo s > /tmp/x')).exitCode).toBe(0);
    expect(await parent.agent.statWorkspaceFile('/tmp/x')).toMatchObject({ ok: true, value: null });
  });

  test('an archive keeps the home', async () => {
    const { parent, name, agentName } = await addedAgent();
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(DIRECTORY);

    await parent.agent.dismissSubordinate(name, true);

    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(DIRECTORY);
  });

  test('a wipe releases the home and its temp root with the storage', async () => {
    const { parent, name, agentName } = await addedAgent();
    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject(DIRECTORY);

    await parent.agent.dismissSubordinate(name, false);

    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toMatchObject({ ok: true, value: null });
    expect(await parent.agent.statWorkspaceFile(agentTmpRoot(agentName))).toMatchObject({ ok: true, value: null });
  });
});
