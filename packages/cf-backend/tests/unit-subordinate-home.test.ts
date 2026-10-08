import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * A hosted subordinate gets a home on its workspace, runs as it, and gives it back on a wipe
 * (kept on an archive), all through the production seams.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentHome, agentTmpRoot, buildBuiltinTools, actorHomeName } from '@kinu.run/core';
import { present, toolExecute } from '@kinu.run/test-utils';
import { conversationsFor } from '../../core/tests/helpers';
import { hostedSubordinateHarness, orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

/** An agent the owner adds takes the workspace's mission, which the soul states. */
const SOUL = '# Kinu\n\n## Mission\n\nBuild the thing.\n';

const DIRECTORY = { type: 'directory' };

const SHELL_OUTPUT = v.object({ stdout: v.string() });

/** An agent the owner added, as the browser adds one, and the home name its directory row gives it. */
async function addedAgent(): Promise<{ parent: ActorHarness<HarnessOrchestratorAgent>; name: string; agentName: string }> {
  const parent = orchestratorHarness();
  await parent.agent.setSoul(SOUL);
  const { name } = await parent.agent.createSubordinateAgent();

  const row = parent.db.query<{ storage_key: string }, [string]>(
    "SELECT storage_key FROM workspace_actors WHERE name = ? AND origin IN ('user', 'agent', 'evolution')",
  ).get(name);

  if (row === null) throw new Error(`no directory row names ${name}`);

  return { parent, name, agentName: actorHomeName({ origin: 'agent', name, storageKey: row.storage_key }) };
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
    const agentName = actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey });

    const home = await parent.agent.statWorkspaceFile(agentHome(agentName));
    expect(home).toMatchObject(DIRECTORY);
    const shell = child.actor.runtime.shell;

    if (!shell) throw new Error('a hosted subordinate runtime carries a shell');
    const identity = await shell.exec('printf "%s %s" "$HOME" "$TMPDIR"');
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.split(' ')).toEqual([agentHome(agentName), agentTmpRoot(agentName)]);
    await writeText(child.actor.runtime.storage.vfs, `${agentHome(agentName)}/notes.md`, 'mine');
    await expect(writeText(child.actor.runtime.storage.vfs, '/home/main/theirs.md', 'x'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect((await shell.exec('echo s > /tmp/x')).exitCode).toBe(0);
    expect(await parent.agent.statWorkspaceFile('/tmp/x')).toBeNull();
  });

  // A call that may outlive its window streams its output, and ran as the session user: the actor's identity was put
  // on the box's buffered calls only.
  test('a call that streams its output runs as the subordinate too', async () => {
    const parent = orchestratorHarness();
    const child = await hostedSubordinateHarness(parent, { ...hire, name: 'builder-3' });
    const agentName = actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey });
    const shell = present(child.actor.runtime.shell, 'a hosted subordinate runtime carries a shell');
    const heard: string[] = [];
    const decoder = new TextDecoder();

    const identity = await shell.exec('printf "%s %s %s" "$HOME" "$TMPDIR" "$(id -u)"', {
      output: { write: (_stream, data) => { heard.push(v.is(v.string(), data) ? data : decoder.decode(data)); }, lost: () => {} },
    });

    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.split(' ').slice(0, 2)).toEqual([agentHome(agentName), agentTmpRoot(agentName)]);
    expect(heard.join('')).toBe(identity.stdout);
    // Not the session user's uid, which the parent's own shell runs as.
    expect(identity.stdout.split(' ')[2]).not.toBe(v.parse(SHELL_OUTPUT, await parent.agent.executeInExecutor('workspace', 'id -u')).stdout.trim());
  });

  // A relative path names the actor's own working directory, its home, as its shell's cwd does.
  test("a large result of its shell is saved in its own home, and the marker's path reads back from its file tool and any shell cwd", async () => {
    const parent = orchestratorHarness();
    const child = await hostedSubordinateHarness(parent, { ...hire, name: 'builder-2' });
    const tools = buildBuiltinTools({ rt: child.actor.runtime, workMode: 'build', conversations: conversationsFor(child.actor.runtime) });
    const shell = toolExecute<{ command: string }, string>(present(tools.shell, 'shell'));
    const file = toolExecute<{ op: 'read'; path: string; offset?: number; limit?: number }, string>(present(tools.file, 'file'));

    const clamped = await shell({ command: 'seq 1 20000' });
    const saved = present(/full result at ([^\]]+)\]/u.exec(clamped)?.[1], 'the saved path');

    expect(clamped).not.toContain('the full result was not saved');
    expect(saved).toStartWith(`${agentHome(actorHomeName({ origin: 'agent', name: child.actor.handle.name, storageKey: child.actor.handle.storageKey }))}/.kinu/tool-output/`);
    expect(await file({ op: 'read', path: saved, offset: 19_999, limit: 2 })).toContain('20000');
    expect(await shell({ command: `cd /tmp && tail -n 1 ${saved}` })).toContain('20000');
  });

  test('a chat opened with words is named from them, and its home is /home/<name>', async () => {
    const parent = orchestratorHarness();
    await parent.agent.setSoul(SOUL);
    const first = await parent.agent.createSubordinateAgent('Fix the coupon expiry check in pricing.ts');
    // The same words again: a name the workspace has had is numbered, so the two homes stay two.
    const second = await parent.agent.createSubordinateAgent('Fix the coupon expiry check, again');

    expect([first.name, second.name]).toEqual(['fix-coupon-expiry', 'fix-coupon-expiry-2']);
    expect(await parent.agent.statWorkspaceFile('/home/fix-coupon-expiry')).toMatchObject(DIRECTORY);
    expect(await parent.agent.statWorkspaceFile('/home/fix-coupon-expiry-2')).toMatchObject(DIRECTORY);
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

    expect(await parent.agent.statWorkspaceFile(agentHome(agentName))).toBeNull();
    expect(await parent.agent.statWorkspaceFile(agentTmpRoot(agentName))).toBeNull();
  });
});
