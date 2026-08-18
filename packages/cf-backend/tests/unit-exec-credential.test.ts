/**
 * The exec credential seam.
 *
 * A programmatic exec runs under the session user unless the caller names an
 * identity. These probes drive the real chain — SDK `exec` -> `_rpcExec` ->
 * `processes.spawn` -> `Shell.execute` -> `vfs.as(cred)` -> coreutil — and
 * assert both halves of an identity: what it may write, and what it may not.
 *
 * Fail-closed is the half worth testing. An identity that writes as itself but
 * is not refused anywhere is a label, not a credential.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { Nimbus, type NimbusExecOptions } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import {
  ensureProgrammaticReady,
  rpcExec,
  rpcProcessLogs,
  rpcStartProcess,
  type ProgrammaticExecOptions,
  type ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const ROOT: VfsCred = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const SESSION_USER: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const AGENT_A: VfsCred = { uid: 2001, gid: 2001, groups: [2001], umask: 0o022 };

function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    const source = new DataView(value.buffer, value.byteOffset, value.byteLength);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = source.getUint8(index);
    return bytes;
  }
  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

async function openWorkspace(): Promise<NimbusWorkspace> {
  const database = new Database(':memory:');
  databases.push(database);
  const sql: SqlDatabase = {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);
      return [];
    },
  };
  return NimbusWorkspace.create({
    sql,
    transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
    generation: 1,
  });
}

function workerHost(workspace: NimbusWorkspace): ProgrammaticHost {
  const durableState = new Map<string, unknown>();
  return {
    _w1SessionDestroyed: false,
    env: {},
    ctx: {
      storage: {
        get: async (key) => durableState.get(key),
        put: async (key, value) => { durableState.set(key, value); },
        delete: async (key) => { durableState.delete(key); },
        deleteAll: async () => { durableState.clear(); },
        deleteAlarm: async () => undefined,
      },
    },
    shell: workspace.shell,
    shellProcessPid: null,
    sqliteFs: workspace.vfs,
    processes: new SessionProcessSupervisor(),
    portRegistry: new PortRegistry(),
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: workspace.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    ensureSqliteFs: () => undefined,
    ensureFacetManager: () => undefined,
    initSession: async () => { throw new Error('workspace is already composed'); },
  };
}

function sdkBox(host: ProgrammaticHost) {
  const stub = {
    _rpcReady: (options?: { preinstall?: string[] }) => ensureProgrammaticReady(host, options),
    _rpcExec: (command: string, options?: ProgrammaticExecOptions) => rpcExec(host, command, options),
    _rpcStartProcess: (command: string, options?: ProgrammaticExecOptions) => (
      rpcStartProcess(host, command, options)
    ),
    _rpcProcessLogs: (pid: number) => rpcProcessLogs(host, pid),
  };
  return Nimbus.fromEnv({ NIMBUS_SESSION: { idFromName: (name: string) => name, get: () => stub } })
    .sandbox('workspace', { root: '/home/user' });
}

/**
 * Host-side provisioning. Per-agent-uid `chown` is uid-0 only, so the agent's
 * own home cannot be created by the agent — the host creates it and hands it
 * over, which is the same order a real workspace boot uses.
 */
function provisionHome(workspace: NimbusWorkspace, path: string, cred: VfsCred): void {
  const root = workspace.vfs.as(ROOT);
  root.mkdir(path, { recursive: true });
  root.chown(path, cred.uid, cred.gid);
  root.chmod(path, 0o700);
}

async function statUid(workspace: NimbusWorkspace, path: string): Promise<number> {
  const stat = await workspace.vfs.as(ROOT).stat(path);
  if (stat === null) throw new Error(`no inode at ${path}`);
  return stat.uid;
}

const asAgent: NimbusExecOptions = { cred: AGENT_A };

describe('programmatic exec under a named credential', () => {
  test('a redirect writes as the named identity, not as the session user', async () => {
    const workspace = await openWorkspace();
    provisionHome(workspace, '/home/agent-a', AGENT_A);

    const box = sdkBox(workerHost(workspace));
    expect(await box.exec('echo mine > /home/agent-a/proof.txt', asAgent))
      .toMatchObject({ exitCode: 0 });

    expect(await workspace.vfs.as(ROOT).readFileString('/home/agent-a/proof.txt')).toBe('mine\n');
    expect(await statUid(workspace, '/home/agent-a/proof.txt')).toBe(AGENT_A.uid);
  });

  test('a coreutil write is attributed to the named identity', async () => {
    const workspace = await openWorkspace();
    provisionHome(workspace, '/home/agent-a', AGENT_A);

    const box = sdkBox(workerHost(workspace));
    expect(await box.exec('mkdir /home/agent-a/made && touch /home/agent-a/made/file', asAgent))
      .toMatchObject({ exitCode: 0 });

    expect(await statUid(workspace, '/home/agent-a/made')).toBe(AGENT_A.uid);
    expect(await statUid(workspace, '/home/agent-a/made/file')).toBe(AGENT_A.uid);
  });

  test('the identity is refused where it has no permission, and nothing lands', async () => {
    const workspace = await openWorkspace();
    provisionHome(workspace, '/home/agent-a', AGENT_A);
    provisionHome(workspace, '/home/user/private', SESSION_USER);

    const box = sdkBox(workerHost(workspace));
    const refused = await box.exec('echo leak > /home/user/private/leak.txt', asAgent);

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toContain('permission denied');
    expect(await workspace.vfs.as(ROOT).exists('/home/user/private/leak.txt')).toBe(false);
  });

  test('a refused traversal cannot even be read by the wrong identity', async () => {
    const workspace = await openWorkspace();
    provisionHome(workspace, '/home/user/private', SESSION_USER);
    workspace.vfs.as(SESSION_USER).writeFile('/home/user/private/secret.txt', 'session bytes');

    const box = sdkBox(workerHost(workspace));
    const refused = await box.exec('cat /home/user/private/secret.txt', asAgent);

    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout).not.toContain('session bytes');
    expect(await box.exec('cat /home/user/private/secret.txt')).toMatchObject({
      exitCode: 0,
      stdout: 'session bytes',
    });
  });

  test('the same command under two identities lands as two different owners', async () => {
    const workspace = await openWorkspace();
    provisionHome(workspace, '/home/agent-a', AGENT_A);
    const shared = workspace.vfs.as(ROOT);
    shared.mkdir('/home/shared', { recursive: true });
    shared.chmod('/home/shared', 0o777);

    const box = sdkBox(workerHost(workspace));
    expect(await box.exec('touch /home/shared/from-agent', asAgent)).toMatchObject({ exitCode: 0 });
    expect(await box.exec('touch /home/shared/from-session')).toMatchObject({ exitCode: 0 });

    expect(await statUid(workspace, '/home/shared/from-agent')).toBe(AGENT_A.uid);
    expect(await statUid(workspace, '/home/shared/from-session')).toBe(SESSION_USER.uid);
  });

  test('an exec that names no credential is unchanged: it is the session user', async () => {
    const workspace = await openWorkspace();
    const box = sdkBox(workerHost(workspace));

    expect(await box.exec('touch /home/user/default.txt')).toMatchObject({ exitCode: 0 });
    expect(await statUid(workspace, '/home/user/default.txt')).toBe(SESSION_USER.uid);
  });

  test('a durable shell carries the credential through its own scoped shell', async () => {
    const workspace = await openWorkspace();
    provisionHome(workspace, '/home/agent-a', AGENT_A);

    const box = sdkBox(workerHost(workspace));
    expect(await box.exec('cd /home/agent-a', { ...asAgent, shellId: 'agent-a:main' }))
      .toMatchObject({ exitCode: 0 });
    expect(await box.exec('touch scoped.txt', { ...asAgent, shellId: 'agent-a:main' }))
      .toMatchObject({ exitCode: 0 });

    expect(await statUid(workspace, '/home/agent-a/scoped.txt')).toBe(AGENT_A.uid);
  });

  test('a background start carries the credential too — same spawn, same seam', async () => {
    const workspace = await openWorkspace();
    provisionHome(workspace, '/home/agent-a', AGENT_A);

    const box = sdkBox(workerHost(workspace));
    const started = await box.startProcess('echo background > /home/agent-a/bg.txt', asAgent);
    expect(started.pid).toBeGreaterThan(0);
    await box.processes.logs(started.pid);

    expect(await statUid(workspace, '/home/agent-a/bg.txt')).toBe(AGENT_A.uid);
  });
});
