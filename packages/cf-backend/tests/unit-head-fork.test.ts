/**
 * Heads are forks of their parent workspace: they read the shared tree directly and write only their own subtree.
 * Defends: a head getting an empty filesystem on its own facet storage and reporting "found nothing".
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { CRAFT_NEUTRAL_PRIOR, agentHome, agentTmpRoot, headAgentName, parseActorKey, type AgentRuntime } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { installSandboxSdkMock, setSandboxSdk } from './helpers/sandbox-sdk';
import type { RecordedUserPlaneCalls } from './helpers/actor-harness';
import type { KinuEgressParams } from '../src/egress/outbound';
import type { CFRuntime } from '../src/runtime';
import * as v from 'valibot';

mockAgentsSdk();

/** Read through an accessor because the test's reset narrows the binding itself to `null`. */
let requestedSandboxId: string | null = null;

const lastRequestedSandboxId = (): string | null => requestedSandboxId;

/** A head rides a container it does not own, so this must stay at zero. */
let restoresPerformed = 0;

const configuredEgress: KinuEgressParams[] = [];

// Reset in `afterAll`, so a later file meets the real SDK.
await installSandboxSdkMock();

setSandboxSdk({
  getSandbox: (_ns: NonNullable<Env['Sandbox']>, id: string) => {
    requestedSandboxId = id;

    return {
      resolveReadiness: async () => ({ kind: 'restored' as const }),
      // A command with no deadline takes the process lane; `exec` is the SDK's bounded lane and not what the handle reaches.
      startProcess: async () => ({
        id: 'p1',
        exitCode: 0,
        waitForExit: async () => ({ exitCode: 0 }),
        getStatus: async () => 'exited',
      }),
      getProcessLogs: async () => ({ stdout: '', stderr: '' }),
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      readFile: async () => ({ content: '', exitCode: 0 }),
      writeFile: async () => ({ exitCode: 0 }),
      listFiles: async () => ({ files: [], exitCode: 0 }),
      deleteFile: async () => ({ exitCode: 0 }),
      exposePort: async () => ({}),
      unexposePort: () => {},
      getExposedPorts: async () => [],
      createBackup: async () => null,
      restoreBackup: async () => { restoresPerformed += 1; },
      // A hosted actor rides the configuration its root installed; a head configuring the container would be a defect.
      configureEgress: async (params: KinuEgressParams) => { configuredEgress.push(params); },
    };
  },
});

afterAll(() => { setSandboxSdk(null); });

// Must follow the sandbox double: both helpers' module graphs reach the sandbox SDK.
const { hostedExplorationHarness, orchestratorHarness } = await import('./helpers/actor-harness');

const { TEST_CREDENTIAL_ENCRYPTION_KEY } = await import('./helpers/user-do');

/** Core's `AgentRuntime` narrows the declared type, so the CF runtime is recovered by its two unique members. */
function isCFRuntime(runtime: AgentRuntime): runtime is CFRuntime {
  return 'localVfs' in runtime && 'sandboxHandle' in runtime;
}

/** The workspace has a container, so the head's runtime registers a sandbox executor over it. */
async function hostedHead(files: Record<string, string> = {}, id = 'head-1', userPlane?: RecordedUserPlaneCalls) {
  const workspace = orchestratorHarness(userPlane, { container: true });
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });

  for (const [path, content] of Object.entries(files)) {
    const written = await workspace.agent.writeWorkspaceFile({ kind: 'file', path, data: content });

    if (!written.ok) throw new Error(`the fixture could not seed ${path}`);
  }

  const head = await hostedExplorationHarness(workspace, 'head', id);
  const rt = head.actor.runtime;

  if (!isCFRuntime(rt)) throw new Error('the hosted head did not receive a CF runtime');

  const home = agentHome(headAgentName(parseActorKey(head.actor.record.storageKey).id));

  return { workspace, head, rt, home };
}

function workspacePlane(rt: CFRuntime) {
  const provider = rt.executionRouter?.getProvider('workspace');

  if (!provider) throw new Error('the hosted head acquired no workspace execution plane');

  return provider;
}

describe('a head forks its parent workspace', () => {
  test("the canonical workspace's files are readable without a parent executor", async () => {
    const { rt } = await hostedHead({ 'repo/README.md': '# cloned project' });

    const workspace = workspacePlane(rt);
    expect(await workspace.tools.readFile.execute('/home/main/repo/README.md')).toBe('# cloned project');
    // No `parent` executor: the head reads the workspace tree directly instead of forwarding over Durable Object RPC.
    expect(rt.executionRouter?.listExecutors().map((executor) => executor.name))
      .not.toContain('parent');
  });

  test('the canonical workspace directory listing reaches the head', async () => {
    const { rt } = await hostedHead({ 'repo/src/index.ts': 'x', 'repo/package.json': '{}' });

    const names = v.parse(
      v.array(v.string()),
      await workspacePlane(rt).tools.readdir.execute('/home/main/repo'),
    );

    expect(names.sort()).toEqual(['package.json', 'src']);
  });

  test("searching the workspace is one real shell call in the head's own shell", async () => {
    const { rt, head, home } = await hostedHead({ 'repo/a.ts': 'needle here', 'repo/b.ts': 'nothing' });

    const found = await workspacePlane(rt).tools.exec.execute('grep -rl needle /home/main/repo');
    expect(v.parse(v.string(), found)).toContain('repo/a.ts');

    const shell = rt.shell;

    if (!shell) throw new Error('a hosted head runtime carries a shell');
    const identity = await shell.exec('printf "%s %s" "$HOME" "$TMPDIR"');
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.split(' '))
      .toEqual([home, agentTmpRoot(headAgentName(parseActorKey(head.actor.record.storageKey).id))]);
  });

  test('exec planes are keyed to the PARENT workspace, not the head actor', async () => {
    requestedSandboxId = null;
    const { head } = await hostedHead();

    // The file plane is keyed by the registered workspace so a self-named child cannot derive a second, empty filesystem.
    expect(lastRequestedSandboxId()).toBe('kinu-harness-parent');
    expect(lastRequestedSandboxId()).not.toContain(head.actor.record.storageKey);
  });

  test('a head never decides the restore of the container it only rides', async () => {
    restoresPerformed = 0;
    const { rt, head, workspace } = await hostedHead();
    // `kinu-harness-parent` belongs to the workspace; acting on it would roll the shared container back.
    workspace.db.prepare("INSERT INTO actor_config (actor_id,key,value) VALUES (?,'workspace_backup',?)")
      .run(head.actor.handle.actorId, JSON.stringify({ id: 'bk-1', dir: '/workspace' }));

    const handle = rt.sandboxHandle;

    if (!handle) throw new Error('a hosted head runtime rides the workspace container');
    await handle.exec('true');
    await handle.exec('true');

    // The second touch matters: a restore from an empty key is one-shot and never retried.
    expect(restoresPerformed).toBe(0);
  });

  test('an owner vault that cannot be read fails the operation, never configuring the container empty', async () => {
    const unreadable = new Error('the owner object reset mid-call');
    configuredEgress.length = 0;

    const { rt } = await hostedHead({}, 'head-vault', {
      warmConnections: [], failWarm: null, titles: [], failVault: unreadable,
    });

    const handle = rt.sandboxHandle;

    if (!handle) throw new Error('a hosted head runtime rides the workspace container');
    // An empty vault here would be memoized for the handle's life.
    await expect(handle.exec('true')).rejects.toBe(unreadable);
    expect(configuredEgress).toEqual([]);
  });

  /** Asserted as a pair: a refusal alone would also hold for a head with no file plane at all. */
  test('a head reads the canonical workspace and writes only its own home', async () => {
    const { rt, home, workspace } = await hostedHead({ 'repo/parser.ts': 'one\ntwo\n' });
    const plane = workspacePlane(rt);

    expect(await plane.tools.readFile.execute('/home/main/repo/parser.ts')).toBe('one\ntwo\n');
    await rt.storage.vfs.writeFile(`${home}/notes.md`, 'visible');
    expect(await workspace.agent.readWorkspaceFile(`${home}/notes.md`))
      .toMatchObject({ ok: true });
    await expect(rt.storage.vfs.writeFile('/home/main/repo/parser.ts', 'one\ntwo\nthree\n'))
      .rejects.toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(await workspace.agent.readWorkspaceFile('/home/main/repo/parser.ts'))
      .toMatchObject({ ok: true, value: new TextEncoder().encode('one\ntwo\n') });
  });

  /** `listTools` reads quality columns on `crafted_tools`, so a head without that table fails its first call. */
  test("the head's own workspace plane scores the tools it crafts", async () => {
    const { rt } = await hostedHead();
    const plane = workspacePlane(rt);

    expect(await plane.tools.listTools.execute()).toEqual([]);
    expect(await plane.tools.createTool.execute(
      'echo_back', 'Return its argument.', 'async (args) => args',
    )).toEqual({ ok: true, name: 'echo_back', action: 'created' });
    expect(await plane.tools.listTools.execute()).toEqual([
      { name: 'echo_back', description: 'Return its argument.', qualityScore: CRAFT_NEUTRAL_PRIOR },
    ]);
  });
});
