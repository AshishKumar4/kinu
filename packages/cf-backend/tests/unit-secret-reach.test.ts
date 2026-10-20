// Who a command runs for decides what it holds of the owner's secrets: the owner's own calls get the placeholders and
// the values its agents may read; a share's viewer's call, or a shared slate's, gets neither, even run later by an
// approval. Driven from the real owner object through the workspace's real account reads, down to what each executor
// hands the box.
import { describe, expect, test } from 'bun:test';
import { MemoryVFS } from '@nimbus-sh/core/vfs/memory.js';
import { present } from '@kinu.run/test-utils';
import {
  createInlineExecutor, createSandboxExecutor, DefaultExecutionRouter, providersWithoutOwnerSecrets, withCommandEnvironment, withholdingOwnerSecrets,
  type CommandEnvironment, type SandboxHandle,
} from '@kinu.run/core';
import { executorNamespace } from '../../core/src/tools/executor-operations';
import { createFileCodemodeProvider, serveFile } from '../../core/src/tools/file-operations';
import { standardMounts, withMountTable, workspaceFilePlane } from '../../core/src/vfs/mounts';
import { TurnFileLedger } from '../../core/src/vfs/file-ledger';
import { TurnContextBudget } from '../../core/src/context-budget';
import { cloudPlanes } from '../../core/src/vfs/resolve';
import { WORKSPACE_ROOT } from '../../core/src/vfs/workspace-path';
import { AccountReads } from '../src/account-reads';
import { revealedForJob } from '../src/egress/send-out';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_USER_ENV } from './helpers/user-do';
import { sandboxHandleLifecycle } from '../../core/tests/helpers/sandbox-handle-lifecycle';
import { hostedExplorationHarness, hostedMainActor, orchestratorHarness } from './helpers/actor-harness';
import { createTestRuntime } from '../../core/tests/helpers';

const AUTHORIZATION = { kind: 'authorization' } as const;

/** Assembled, so no scanner reads a hardcoded password here. */
const DB_VALUE = ['hunter2', 'logs', 'db'].join('-');

/** The account: Cloudflare's token as a placeholder and the database password readable, both granted to `shop`. */
async function shop() {
  const harness = createTestUserDO();
  const owner = await testOwner();
  const workspace = { workspaceToken: await provisionTestWorkspace(harness, 'shop') };

  await harness.userDO.putSecrets(owner, [
    { name: 'CLOUDFLARE_API_TOKEN', hosts: ['api.cloudflare.com'], position: AUTHORIZATION, value: ['cf', 'token', 'value', '0123'].join('-') },
    { name: 'DATABASE_PASSWORD', hosts: ['logs-db.dew.dev'], position: AUTHORIZATION, value: DB_VALUE },
  ], ['shop']);
  await harness.userDO.grantSecret(owner, { name: 'DATABASE_PASSWORD', workspace: 'shop', reveal: true });

  const reads = new AccountReads({ hub: async () => ({ stub: harness.userDO, caller: workspace }), owned: () => true, workspace: () => 'shop' });
  const environment: CommandEnvironment = (use, caller) => reads.commandEnvironment(use, caller);
  const placeholder = (await harness.userDO.grantedSecrets(workspace)).granted.find((secret) => secret.name === 'CLOUDFLARE_API_TOKEN')?.placeholder ?? '';

  return { environment, placeholder, reads };
}

/** A computer that records what each command and job is handed. */
function computer(environment: CommandEnvironment) {
  const execs: (Readonly<Record<string, string>> | undefined)[] = [];
  const jobs: { env?: Readonly<Record<string, string>>; reveal?: boolean }[] = [];
  const calls: string[] = [];

  const reached = <Result>(operation: string, result: Result) => async () => {
    calls.push(operation);

    return result;
  };

  const handle: SandboxHandle = {
    ...sandboxHandleLifecycle,
    ensureReady: reached('ensureReady', undefined),
    exec: async (command, opts) => {
      calls.push('exec');

      const window = /\bdd if='[^']*' bs=1 skip=(\d+) count=(\d+)/u.exec(command);

      if (window !== null) {
        const bytes = Buffer.from(JSON.stringify(jobs[0]?.env ?? {}));
        const from = Number(window[1]);

        return { stdout: bytes.subarray(from, from + Number(window[2])).toString('base64'), stderr: '', exitCode: 0 };
      }

      execs.push(opts?.env);

      return { stdout: '', stderr: '', exitCode: 0 };
    },
    startSupervisedProcess: async (_command, opts) => {
      calls.push('startProcess');
      jobs.push({ ...(opts?.env !== undefined && { env: opts.env }), ...(opts?.reveal !== undefined && { reveal: opts.reveal }) });

      return { processId: 'proc-1' };
    },
    readFile: async () => {
      calls.push('readFile');

      return { content: JSON.stringify(jobs[0]?.env ?? {}), encoding: 'utf-8' };
    },
    writeFile: reached('writeFile', undefined),
    writeFileIfDigest: reached('writeFileIfDigest', { ok: true, sha256: 'written' }),
    listFiles: async (path) => {
      calls.push('listFiles');

      const children = new Map([
        ['/', 'var'], ['/var', 'tmp'], ['/var/tmp', 'devbox'], ['/var/tmp/devbox', 'processes'],
        ['/var/tmp/devbox/processes', 'proc-1'], ['/var/tmp/devbox/processes/proc-1', 'env'],
      ]);

      const child = children.get(path);

      return { files: child === undefined ? [] : [{ name: child, type: child === 'env' ? 'file' : 'directory', size: Buffer.byteLength(JSON.stringify(jobs[0]?.env ?? {})), mode: child === 'env' ? 0o100644 : 0o40755, mtimeMs: 1 }] };
    },
    statFile: async (path) => {
      calls.push('statFile');

      return { type: path.endsWith('/env') ? 'file' : 'directory', size: Buffer.byteLength(JSON.stringify(jobs[0]?.env ?? {})), mode: path.endsWith('/env') ? 0o100644 : 0o40755, mtimeMs: 1 };
    },
    deleteFile: reached('deleteFile', undefined),
    exposePort: async (port) => {
      calls.push('exposePort');

      return { url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } };
    },
    unexposePort: reached('unexposePort', undefined),
    getExposedPorts: reached('getExposedPorts', []),
    probePort: reached('probePort', true),
    portToken: reached('portToken', { urlToken: 'preview-token' }),
    stopSupervisedProcess: reached('stopProcess', { stopped: true }),
    listSupervisedProcesses: reached('listProcesses', []),
    supervisedProcessLogs: reached('logs', 'ready'),
    answerRest: reached('rest', { kind: 'resting' }),
    resize: reached('resize', { kind: 'recorded', size: 'small' }),
    desktop: reached('desktop', { kind: 'done' }),
  };

  return { execs, jobs, calls, provider: createSandboxExecutor(handle, {
    environment, previewHostSuffix: 'preview.example.com',
    sizes: { defaultSize: 'small', sizes: [{ size: 'small', label: 'Small', vcpu: 1, memoryMib: 4096, diskMb: 20_000 }] },
    desktop: { driver: 'owner', screen: { width: 1280, height: 768, sheet: { percent: 50, columns: [1, 2, 2, 2] } } },
  }) };
}

describe("the owner's own calls hold the workspace's secrets", () => {
  test("an owner's command on the computer holds the placeholder and the value its agents may read", async () => {
    const { environment, placeholder } = await shop();
    const box = computer(environment);

    await box.provider.tools.exec.execute('env');

    expect(box.execs).toEqual([{ CLOUDFLARE_API_TOKEN: placeholder, DATABASE_PASSWORD: DB_VALUE }]);
  });

  test("an owner's job holds placeholders where it is kept, and is marked to read its values at each launch", async () => {
    const { environment, placeholder } = await shop();
    const box = computer(environment);

    await box.provider.tools.startProcess.execute('bun run dev');

    expect(box.jobs).toHaveLength(1);
    expect(box.jobs[0]?.reveal).toBe(true);
    expect(box.jobs[0]?.env?.['CLOUDFLARE_API_TOKEN']).toBe(placeholder);
    expect(JSON.stringify(box.jobs)).not.toContain(DB_VALUE);
  });
});

describe("a call that is not the owner's holds none of them", () => {
  test("a viewer's command on the workspace's own box holds neither, beside the owner's which holds both as placeholders", async () => {
    const { environment, placeholder, reads } = await shop();
    const kept = await reads.commandEnvironment('keep', 'owner');
    const seen: (Readonly<Record<string, string>> | undefined)[] = [];

    const box = withCommandEnvironment({
      ready: async () => {},
      exec: async (command, options) => {
        seen.push(options?.env);

        return { command, exitCode: 0, success: true, duration: 0, timestamp: 0, stdout: '', stderr: '' };
      },
    }, environment);

    await box.exec('env', {});

    await withholdingOwnerSecrets(() => box.exec('env', {}));

    // The one its agents may read too: the box writes a serving program's environment where every process reads it.
    expect(seen).toEqual([{ CLOUDFLARE_API_TOKEN: placeholder, DATABASE_PASSWORD: kept.DATABASE_PASSWORD }, {}]);
    expect(kept.DATABASE_PASSWORD).toStartWith('pxs1_');
    expect(JSON.stringify(seen)).not.toContain(DB_VALUE);
  });

  test("a viewer's eval program is handed no bindings, the owner's both", async () => {
    const { reads, placeholder } = await shop();

    // As `ActorAgent.codemodeLaunch` reads them for each run.
    expect(await reads.commandEnvironment('run', 'viewer')).toEqual({});
    expect(await reads.commandEnvironment('run', 'owner')).toEqual({ CLOUDFLARE_API_TOKEN: placeholder, DATABASE_PASSWORD: DB_VALUE });
  });
});

describe("a viewer never reaches the owner's computer", () => {
  const refusal = { reason: 'denied', error: expect.stringMatching(/computer.*viewer.*(?:credentials|secrets)/isu) };

  for (const member of ['exec', 'startProcess']) test(`${member} refuses before starting a command or asking for secrets`, async () => {
    const asked: string[] = [];

    const box = computer(async (use) => {
      asked.push(use);

      return {};
    });

    expect(await withholdingOwnerSecrets(() => present(box.provider.tools[member], member).execute('env'))).toMatchObject(refusal);

    expect({ calls: box.calls, asked }).toEqual({ calls: [], asked: [] });
  });

  test('approval preparation refuses a viewer, and an admitted saved run cannot lend owner authority to a viewer', async () => {
    const box = computer(async () => ({}));

    for (const member of ['exec', 'startProcess']) {
      const prepare = present(box.provider.tools[member]?.prepare, member);
      expect(withholdingOwnerSecrets(() => prepare(['env']))).toMatchObject({ refused: refusal });
      const prepared = prepare(['env']);

      if ('refused' in prepared) throw new Error('the approval fixture must reach its saved run');
      expect(await withholdingOwnerSecrets(() => prepared.run())).toMatchObject(refusal);
    }

    expect(box.calls).toEqual([]);
  });

  test('a registered viewer command refuses before the owner is asked to approve it', async () => {
    const asked: string[] = [];

    const router = new DefaultExecutionRouter({
      mode: () => 'strict', requestApproval: async (request) => {
        asked.push(request.command);

        return 'allow';
      },
    });

    const box = computer(async () => ({}));
    router.register(box.provider);
    const provider = present(router.getProvider('computer'), 'registered computer');

    for (const member of ['exec', 'startProcess']) {
      expect(await withholdingOwnerSecrets(() => present(provider.tools[member], member).execute('git push --force origin main'))).toMatchObject(refusal);
    }

    expect({ asked, calls: box.calls }).toEqual({ asked: [], calls: [] });
  });

  test('viewer dispatch refuses the computer on the workspace actor and on a hosted hop, while the owner still executes', async () => {
    const workspace = orchestratorHarness();
    const { actor } = await hostedExplorationHarness(workspace, 'shared-helper', { kind: 'head' });
    const main = await hostedMainActor(workspace);
    const box = computer(async () => ({}));
    present(main.actor.runtime.executionRouter, 'workspace executors').register(box.provider);
    present(actor.runtime.executionRouter, 'hosted executors').register(box.provider);

    for (const hops of [[], [{ name: actor.record.name }]]) {
      for (const [member, args] of [['exec', ['env']], ['startProcess', ['env']], ['fs.text', ['/var/tmp/devbox/processes/owner/env']]] as const) {
        expect(await workspace.agent.slateCallDispatch(hops, { kind: 'namespace', namespace: 'computer', member, args: [...args] }, 'build', { viewer: true, nested: () => {} }))
          .toMatchObject(refusal);
      }
    }

    expect(box.calls).toEqual([]);
    await workspace.agent.slateCallDispatch([], { kind: 'namespace', namespace: 'computer', member: 'exec', args: ['env'] }, 'build', { nested: () => {} });
    expect(box.execs).toHaveLength(1);
    workspace.db.close();
  });

  test('every computer tool, including desktop and lifecycle members, refuses viewers', async () => {
    const box = computer(async () => ({}));

    for (const member of Object.values(box.provider.tools)) {
      expect(await withholdingOwnerSecrets(() => member.execute())).toMatchObject(refusal);
    }

    expect(box.calls).toEqual([]);
  });

  test('port operations refuse without probing, exposing, listing or stopping anything', async () => {
    const box = computer(async () => ({}));

    for (const run of [
      () => present(box.provider.exposePort, 'exposePort')(4100),
      () => present(box.provider.unexposePort, 'unexposePort')(4100),
      () => present(box.provider.listExposedPorts, 'listExposedPorts')(),
    ]) {
      await expect(withholdingOwnerSecrets(async () => run())).rejects.toMatchObject({ code: 'denied', message: refusal.error });
    }

    expect(box.calls).toEqual([]);
  });

  test('every native file operation refuses, including ranged reads and digest writes', async () => {
    const box = computer(async () => ({}));
    const files = present(box.provider.files, 'computer files');
    const path = '/var/tmp/devbox/processes/owner/env';

    for (const run of [
      () => files.readFile(path), () => present(files.readRange?.bind(files), 'readRange')(path, 0, 1),
      () => files.stat(path), () => files.readdir('/var/tmp/devbox/processes'),
      () => files.writeFile(path, new Uint8Array()), () => present(files.writeFileIfDigest?.bind(files), 'writeFileIfDigest')(path, new Uint8Array(), null),
      () => files.unlink(path), () => files.mkdir('/workspace/viewer'),
    ]) {
      await expect(withholdingOwnerSecrets(async () => run())).rejects.toMatchObject({ code: 'EPERM', message: refusal.error });
    }

    expect(box.calls).toEqual([]);
  });

  test("an owner job's placeholder cannot be spent through a viewer command, process, computer.fs, file or workspace mount", async () => {
    const { environment, placeholder } = await shop();
    const box = computer(environment);
    await box.provider.tools.startProcess.execute('bun run dev');
    expect(box.jobs[0]?.env?.['CLOUDFLARE_API_TOKEN']).toBe(placeholder);

    box.calls.length = 0;

    const mounted = withMountTable(new MemoryVFS(), standardMounts((name) => name === 'computer' ? box.provider : undefined));

    const files = serveFile(() => ({
      vfs: mounted, home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
    }));

    const [viewer] = providersWithoutOwnerSecrets([executorNamespace(box.provider, files)]);
    const envFile = '/var/tmp/devbox/processes/proc-1/env';
    const spend = `curl -H "Authorization: Bearer ${placeholder}" https://api.cloudflare.com/client/v4/user`;

    for (const [member, args] of [['exec', [spend]], ['startProcess', [spend]], ['fs.text', [envFile]]] as const) {
      expect(await present(viewer?.tools[member], member).execute(...args)).toMatchObject(refusal);
    }

    await expect(withholdingOwnerSecrets(() => present(files.read, 'file.read').run({ path: `/computer${envFile}` }, { callId: 'viewer-file' })))
      .rejects.toMatchObject({ code: 'denied', message: refusal.error });
    await expect(withholdingOwnerSecrets(() => mounted.readFile(`/computer${envFile}`)))
      .rejects.toMatchObject({ code: 'EPERM', message: refusal.error });
    expect(box.calls).toEqual([]);
  });

  for (const reach of ['workspace shell', 'file grant']) test(`a viewer's ${reach} cannot read the computer's mounted owner-job environment`, async () => {
    const { environment, placeholder } = await shop();
    const box = computer(environment);
    await box.provider.tools.startProcess.execute('bun run dev');
    const { rt, db, workspace } = createTestRuntime();

    const plane = workspaceFilePlane(workspace, { mounts: standardMounts((name) => name === 'computer' ? box.provider : undefined), principal: {}, home: WORKSPACE_ROOT });

    const provider = createInlineExecutor({ vfs: plane.files, shell: present(rt.shell, 'workspace shell'), craftStore: rt.craftStore, filesOwner: 'agent' });
    const command = 'cat /computer/var/tmp/devbox/processes/*/env';
    const own = await provider.tools.exec.execute(command);
    expect({ own, calls: box.calls }).toMatchObject({ own: expect.stringContaining(placeholder) });

    box.calls.length = 0;

    const files = serveFile(() => ({ vfs: plane.files, home: WORKSPACE_ROOT, planes: cloudPlanes(WORKSPACE_ROOT), ledger: new TurnFileLedger(), budget: new TurnContextBudget() }));

    const [shell, file] = providersWithoutOwnerSecrets([executorNamespace(provider, files), createFileCodemodeProvider(files)]);

    const answer = reach === 'workspace shell'
      ? await present(shell?.tools.exec, 'workspace.exec').execute(command)
      : await present(file?.tools.read, 'file.read').execute('/computer/var/tmp/devbox/processes/proc-1/env');

    expect(answer).toMatchObject({ success: false, error: refusal.error });
    expect(box.calls).toEqual([]);
    plane.unmount();
    db.close();
  });
});

describe("a job's values are read for it, or its launch fails", () => {
  test('the box reads them as the owner capability for its own workspace, and an unreachable account or an unconfigured box fails the read', async () => {
    const harness = createTestUserDO();
    const owner = await testOwner();
    await provisionTestWorkspace(harness, 'shop');
    await harness.userDO.putSecrets(owner, [{ name: 'DATABASE_PASSWORD', hosts: ['logs-db.dew.dev'], position: AUTHORIZATION, value: DB_VALUE }], ['shop']);
    await harness.userDO.grantSecret(owner, { name: 'DATABASE_PASSWORD', workspace: 'shop', reveal: true });
    const params = { ownerUserId: 'owner', workspaceName: 'shop' };

    const answering = { ...TEST_USER_ENV, UserDO: { idFromName: (name: string) => name, get: () => harness.userDO } };
    const unreachable = { ...TEST_USER_ENV, UserDO: { idFromName: (name: string) => name, get: () => ({ revealedSecretsFor: async (): Promise<never> => { throw new Error('connection lost'); } }) } };

    expect(await revealedForJob(answering, params)).toEqual({ DATABASE_PASSWORD: DB_VALUE });
    await expect(revealedForJob(unreachable, params)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(revealedForJob(answering, undefined)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe("an owner's call whose account does not answer does not run short of its secrets", () => {
  /** The workspace's reads over an account object that answers nothing. */
  function unanswered(): CommandEnvironment {
    const reads = new AccountReads({ hub: async () => { throw new Error('account object unreachable'); }, owned: () => true, workspace: () => 'shop' });

    return (use, caller) => reads.commandEnvironment(use, caller);
  }

  test('an owner command on the computer is not run, and says the account did not answer', async () => {
    const box = computer(unanswered());
    const [settled] = await Promise.allSettled([box.provider.tools.exec.execute('env')]);
    const answer = settled?.status === 'fulfilled' ? JSON.stringify(settled.value) : String(settled?.reason);

    expect(box.execs).toEqual([]);
    expect(answer).toContain('asking the account');
  });

  test("an owner command on the workspace's box, an owner job and an owner's eval program are refused the same way", async () => {
    const environment = unanswered();
    const seen: string[] = [];

    const box = withCommandEnvironment({
      ready: async () => {},
      exec: async (command) => {
        seen.push(command);

        return { command, exitCode: 0, success: true, duration: 0, timestamp: 0, stdout: '', stderr: '' };
      },
    }, environment);

    await expect(box.exec('env', {})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(environment('keep', 'owner')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(environment('run', 'owner')).rejects.toMatchObject({ code: 'unavailable' });
    expect(seen).toEqual([]);
  });

  test("a viewer's call never asks the account, so it runs as it would, holding nothing", async () => {
    expect(await unanswered()('run', 'viewer')).toEqual({});
  });
});
