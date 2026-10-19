// Who a command runs for decides what it holds of the owner's secrets: the owner's own calls get the placeholders and
// the values its agents may read; a share's viewer's call, or a shared slate's, gets neither, even run later by an
// approval. Driven from the real owner object through the workspace's real account reads, down to what each executor
// hands the box.
import { describe, expect, test } from 'bun:test';
import {
  createSandboxExecutor, providersWithoutOwnerSecrets, withCommandEnvironment, withholdingOwnerSecrets,
  type CommandEnvironment, type SandboxHandle,
} from '@kinu.run/core';
import { AccountReads } from '../src/account-reads';
import { revealedForJob } from '../src/egress/send-out';
import { createTestUserDO, provisionTestWorkspace, testOwner, TEST_USER_ENV } from './helpers/user-do';
import { sandboxHandleLifecycle } from '../../core/tests/helpers/sandbox-handle-lifecycle';

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

  const handle: SandboxHandle = {
    ...sandboxHandleLifecycle,
    exec: async (_command, opts) => {
      execs.push(opts?.env);

      return { stdout: '', stderr: '', exitCode: 0 };
    },
    startSupervisedProcess: async (_command, opts) => {
      jobs.push({ ...(opts?.env !== undefined && { env: opts.env }), ...(opts?.reveal !== undefined && { reveal: opts.reveal }) });

      return { processId: 'proc-1' };
    },
    readFile: async () => ({}),
    writeFile: async () => {},
    listFiles: async () => ({ files: [] }),
    deleteFile: async () => {},
    exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
    unexposePort: async () => {},
    getExposedPorts: async () => [],
  };

  return { execs, jobs, provider: createSandboxExecutor(handle, { environment }) };
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
  test("a viewer's command on the computer holds neither a placeholder nor a value", async () => {
    const { environment } = await shop();
    const box = computer(environment);

    await withholdingOwnerSecrets(() => box.provider.tools.exec.execute('env'));

    expect(box.execs).toEqual([undefined]);
  });

  test("a viewer's command run later, by the approval that admitted it, still holds none", async () => {
    const { environment } = await shop();
    const box = computer(environment);
    const prepared = withholdingOwnerSecrets(() => box.provider.tools.exec.prepare?.(['env']));

    if (prepared === undefined || 'refused' in prepared) throw new Error('the call was not prepared');
    await prepared.run();

    expect(box.execs).toEqual([undefined]);
  });

  test("a namespace a viewer is handed runs for no owner even when a program calls back into it", async () => {
    const { environment } = await shop();
    const box = computer(environment);
    const [viewers] = providersWithoutOwnerSecrets([{ name: 'computer', tools: box.provider.tools }]);

    await viewers?.tools['exec']?.execute('env');

    expect(box.execs).toEqual([undefined]);
  });

  test("a viewer's job is kept with nothing and never reads values", async () => {
    const { environment } = await shop();
    const box = computer(environment);

    await withholdingOwnerSecrets(() => box.provider.tools.startProcess.execute('bun run dev'));

    expect(box.jobs).toEqual([{ env: {}, reveal: false }]);
  });

  test("a viewer's command on the workspace's own box holds neither, beside the owner's which holds both", async () => {
    const { environment, placeholder } = await shop();
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

    expect(seen).toEqual([{ CLOUDFLARE_API_TOKEN: placeholder, DATABASE_PASSWORD: DB_VALUE }, {}]);
  });

  test("a viewer's eval program is handed no bindings, the owner's both", async () => {
    const { reads, placeholder } = await shop();

    // As `ActorAgent.codemodeLaunch` reads them for each run.
    expect(await reads.commandEnvironment('run', 'viewer')).toEqual({});
    expect(await reads.commandEnvironment('run', 'owner')).toEqual({ CLOUDFLARE_API_TOKEN: placeholder, DATABASE_PASSWORD: DB_VALUE });
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
    await expect(revealedForJob(unreachable, params)).rejects.toThrow('asking the account');
    await expect(revealedForJob(answering, undefined)).rejects.toThrow('not yet configured');
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

    await expect(box.exec('env', {})).rejects.toThrow('asking the account');
    await expect(environment('keep', 'owner')).rejects.toThrow('asking the account');
    await expect(environment('run', 'owner')).rejects.toThrow('asking the account');
    expect(seen).toEqual([]);
  });

  test("a viewer's call never asks the account, so it runs as it would, holding nothing", async () => {
    expect(await unanswered()('run', 'viewer')).toEqual({});
  });
});
