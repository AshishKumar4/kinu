import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Nimbus, type NimbusExecOptions } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import {
  programmaticHostOver,
  type DurableState,
  ensureProgrammaticReady,
  rpcExecStream,
  rpcListPorts,
  rpcRouteCapabilityPort,
  durableStorage,
  type ProgrammaticExecOptions,
  type TestProgrammaticHost,
} from './helpers/programmatic-host';
import { clearPortCapability } from '@nimbus-sh/worker/port-capability';
import { inlineWorkspaceStorage } from '@kinu.run/core/identity';
import { Effect } from 'effect';
import {
  createShellSession, DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable, nimbusSessionShell,
  withApprovalGatedShell, type NimbusSandboxHandle,
} from '@kinu.run/core';
import { createTestActors, sqlOver } from '@kinu.run/test-utils';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** A workspace's SQLite, as the CLI hosts it. */
function openWorkspaceDatabase() {
  const database = new Database(':memory:');
  databases.push(database);

  return inlineWorkspaceStorage(database);
}

type DurableShellState = DurableState;

function workerHost(workspace: NimbusWorkspace, durableState: DurableShellState): TestProgrammaticHost {
  return programmaticHostOver(workspace, { durable: durableState });
}

/** Port verbs mapped as production: `expose` exposes the serving process, `unexpose` retires the capability first. */
function sdkBox({ host, portRegistry, durable }: TestProgrammaticHost) {
  const stub = {
    _rpcReady: (options?: { preinstall?: string[] }) => ensureProgrammaticReady(host, options),
    _rpcExecStream: (command: string, options?: ProgrammaticExecOptions) => rpcExecStream(host, command, options),
    _rpcListPorts: () => rpcListPorts(host),
    _rpcExposePort: (port: number) => host.exposeApp({ port }),
    _rpcUnexposePort: async (port: number) => {
      await host.ready();
      await clearPortCapability({ ctx: { storage: durableStorage(durable) }, portRegistry }, port);

      return { port, ok: portRegistry.unregister(port) };
    },
  };

  const namespace = {
    idFromName: (name: string) => name,
    get: () => stub,
  };

  return Nimbus.fromEnv({ NIMBUS_SESSION: namespace }).sandbox('workspace', { root: '/home/main' });
}

const shell = (shellId: string): NimbusExecOptions => ({ shellId });

describe('hosted workspace actor shell state', () => {
  test('successive public SDK calls keep cwd over the authoritative VFS bytes', async () => {
    const storage = openWorkspaceDatabase();

    const workspace = await NimbusWorkspace.create({
      ...storage,
      generation: 1,
    });

    await workspace.fs.mkdir('/home/main/repo', { recursive: true });
    await workspace.fs.writeFile('/home/main/repo/proof.txt', 'same bytes');

    const box = sdkBox(workerHost(workspace, new Map()));
    expect(await box.exec('cd repo', shell('agent:main'))).toMatchObject({ exitCode: 0 });
    expect(await box.exec('pwd', shell('agent:main'))).toMatchObject({
      stdout: '/home/main/repo\n',
      exitCode: 0,
    });
    expect(await box.exec('cat proof.txt', shell('agent:main'))).toMatchObject({
      stdout: 'same bytes',
      exitCode: 0,
    });
    expect(await workspace.fs.readFileString('/home/main/repo/proof.txt')).toBe('same bytes');
  });

  test('concurrent actor shells serialize their own calls without cwd or env leakage', async () => {
    const storage = openWorkspaceDatabase();

    const workspace = await NimbusWorkspace.create({
      ...storage,
      generation: 1,
    });

    await workspace.fs.mkdir('/home/main/alpha', { recursive: true });
    await workspace.fs.mkdir('/home/main/beta', { recursive: true });
    const box = sdkBox(workerHost(workspace, new Map()));

    const alpha = shell('subordinate:alpha');
    const beta = shell('head:beta');

    const [, alphaPwd] = await Promise.all([
      box.exec('cd /home/main/alpha; export ACTOR=alpha', alpha),
      box.exec('pwd; echo $ACTOR', alpha),
      box.exec('cd /home/main/beta; export ACTOR=beta', beta),
    ]);

    expect(alphaPwd).toMatchObject({ stdout: '/home/main/alpha\nalpha\n', exitCode: 0 });
    expect(await box.exec('pwd; echo $ACTOR', beta)).toMatchObject({
      stdout: '/home/main/beta\nbeta\n',
      exitCode: 0,
    });
  });

  test('durable shell state survives worker reconstruction', async () => {
    const storage = openWorkspaceDatabase();


    const durableState: DurableShellState = new Map();
    const firstWorkspace = await NimbusWorkspace.create({ ...storage, generation: 1 });
    await firstWorkspace.fs.mkdir('/home/main/repo', { recursive: true });
    const firstBox = sdkBox(workerHost(firstWorkspace, durableState));
    await firstBox.exec('cd /home/main/repo; export RECONSTRUCTED=yes', shell('agent:main'));

    const reconstructedWorkspace = await NimbusWorkspace.create({ ...storage, generation: 2 });
    const reconstructedBox = sdkBox(workerHost(reconstructedWorkspace, durableState));
    expect(await reconstructedBox.exec('pwd; echo $RECONSTRUCTED', shell('agent:main'))).toMatchObject({
      stdout: '/home/main/repo\nyes\n',
      exitCode: 0,
    });
  });
});

describe('hosted workspace preview capabilities', () => {
  test('the public SDK capability reaches the actual worker/core guest route and is revoked on unexpose', async () => {
    const storage = openWorkspaceDatabase();

    const workspace = await NimbusWorkspace.create({
      ...storage,
      generation: 1,
    });

    const durableState: DurableShellState = new Map();
    const host = workerHost(workspace, durableState);
    let guestRequest: Request | null = null;

    const guest = {
      async handleHttpRequest(request: Request) {
        guestRequest = request;

        return new Response('guest response');
      },
    };

    const receivedGuestRequest = (): Request => {
      if (!guestRequest) throw new Error('guest route was not invoked');

      return guestRequest;
    };

    // An application's owner is derived from the process serving its port.
    const server = workspace.processes.spawn('node', ['node', 'server.js'], '/home/main');
    host.portRegistry.bindFacetStub(server.pid, guest);
    host.portRegistry.register(4321, server.pid);

    const box = sdkBox(host);
    const exposed = await box.ports.expose(4321);
    expect(exposed.capability).toMatch(/^[a-f0-9]{24}$/);

    if (!exposed.capability) throw new Error('listening port did not receive a capability');

    const response = await rpcRouteCapabilityPort(
      host.host,
      4321,
      exposed.capability,
      new Request('https://preview.example/private?view=full', {
        method: 'POST',
        headers: {
          authorization: 'Bearer guest-token',
          cookie: 'guest_session=kept',
          'x-nimbus-tenant': 'must-not-cross',
        },
        body: 'payload',
      }),
      '/private',
    );

    expect(response.status).toBe(200);
    const routed = receivedGuestRequest();
    expect(routed.headers.get('authorization')).toBe('Bearer guest-token');
    expect(routed.headers.get('cookie')).toBe('guest_session=kept');
    expect(routed.headers.get('x-nimbus-tenant')).toBeNull();
    expect(new URL(routed.url).pathname + new URL(routed.url).search).toBe('/private?view=full');
    expect(await routed.text()).toBe('payload');

    guestRequest = null;
    const reconstructedHost = workerHost(workspace, durableState);
    reconstructedHost.portRegistry.bindFacetStub(server.pid, guest);
    reconstructedHost.portRegistry.register(4321, server.pid);
    expect(reconstructedHost.portRegistry.get(4321)?.capability).not.toBe(exposed.capability);
    expect(await rpcRouteCapabilityPort(
      reconstructedHost.host,
      4321,
      exposed.capability,
      new Request('https://preview.example/reconstructed', {
        headers: { authorization: 'Bearer reconstructed-guest' },
      }),
      '/reconstructed',
    )).toMatchObject({ status: 200 });
    expect(receivedGuestRequest().headers.get('authorization')).toBe('Bearer reconstructed-guest');
    expect(reconstructedHost.portRegistry.get(4321)?.capability).toBe(exposed.capability);

    guestRequest = null;
    await reconstructedHost.portRegistry.routeRequest(
      4321,
      new Request('https://nimbus.invalid/private', {
        headers: { authorization: 'Bearer must-be-sanitized' },
      }),
      '/private',
    );
    expect(receivedGuestRequest().headers.get('authorization')).toBeNull();

    const reconstructedBox = sdkBox(reconstructedHost);
    expect(await reconstructedBox.ports.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ port: 4321, capability: exposed.capability }),
    ]));
    await reconstructedBox.ports.unexpose(4321);
    expect(await rpcRouteCapabilityPort(
      reconstructedHost.host,
      4321,
      exposed.capability,
      new Request('https://preview.example/private'),
      '/private',
    )).toMatchObject({ status: 404 });

    reconstructedHost.portRegistry.register(4321, server.pid);
    const reexposed = await reconstructedBox.ports.expose(4321);
    expect(reexposed.capability).toMatch(/^[a-f0-9]{24}$/);
    expect(reexposed.capability).not.toBe(exposed.capability);
  });
});

describe('an approval in a hosted named session', () => {
  /** The session plane as the hosted workspace adapts the public SDK: a name is a shell id. */
  function sessionBox(sdk: ReturnType<typeof sdkBox>): NimbusSandboxHandle {
    return {
      ready: async () => {},
      exec: async (command, options) => {
        const { name, ...rest } = options ?? {};
        const result = await sdk.exec(command, name === undefined ? rest : { ...rest, shellId: name });

        return { command, success: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      },
      shellCwd: async (name) => (await sdk.exec('pwd', shell(name))).stdout.trim() || null,
      files: { read: async () => null, write: async () => {}, list: async () => [], stat: async () => null, exists: async () => false, delete: async () => {} },
    };
  }

  /** A hosted session behind the approval gate, with nobody in front of the owner: every ask parks on the queue. */
  async function unattendedSession() {
    const storage = openWorkspaceDatabase();
    const workspace = await NimbusWorkspace.create({ ...storage, generation: 1 });

    for (const dir of ['a', 'b']) await workspace.fs.mkdir(`/home/main/${dir}`, { recursive: true });

    const db = new Database(':memory:');
    databases.push(db);
    const sql = sqlOver(db);
    const execRaw = (query: string) => { db.exec(query); };

    initDeferredApprovalsTable(execRaw);
    let seq = 0;

    const queue = new DeferredApprovalQueue({
      writes: null,
      store: new DeferredApprovalStore(sql, createTestActors(sql, execRaw).main),
      wake: () => Effect.void,
      remember: () => {},
      newId: () => `ask-${String(seq += 1)}`,
    });

    const sessionShell = nimbusSessionShell(sessionBox(sdkBox(workerHost(workspace, new Map()))), { home: '/home/main' });
    const session = createShellSession({ home: '/home/main', userRoots: () => [], stored: async (name) => await sessionShell.cwd?.(name) ?? null });

    const gated = withApprovalGatedShell(sessionShell, { filesOwner: 'agent', shellSession: session }, {
      mode: () => 'strict', deferrals: queue.channel, requestApproval: null,
    });

    return { workspace, queue, gated };
  }

  const FORCE_PUSH = ['git', 'push --force origin main'].join(' ');

  /** Parks `asked` in session `dev` after `before`, runs `meanwhile` there, approves the row and asks again. */
  async function approveAcrossAChange(before: string, asked: string, meanwhile: string) {
    const { workspace, queue, gated } = await unattendedSession();

    await gated.exec(before, { name: 'dev' });
    expect((await gated.exec(asked, { name: 'dev' })).exitCode).not.toBe(0);
    expect(queue.list()).toHaveLength(1);
    await gated.exec(meanwhile, { name: 'dev' });
    await queue.decide(queue.list().map((row) => row.id), 'approved');

    return { again: await gated.exec(asked, { name: 'dev' }), workspace };
  }

  test('runs on the session it was asked on: a read of the state leaves the state as it was', async () => {
    const { again, workspace } = await approveAcrossAChange('export TARGET=a', `${FORCE_PUSH}; rm -r "$TARGET"`, 'true');

    expect(again.exitCode).toBe(0);
    expect(await workspace.fs.exists('/home/main/a')).toBe(false);
  });

  test('covers the variables the session exports, read inside it: one changed after the ask is another ask', async () => {
    const { again, workspace } = await approveAcrossAChange('export TARGET=a', `${FORCE_PUSH}; rm -r "$TARGET"`, 'export TARGET=b');

    expect(again.exitCode).not.toBe(0);
    expect(await workspace.fs.exists('/home/main/b')).toBe(true);
    expect(await workspace.fs.exists('/home/main/a')).toBe(true);
  });

  /** A change a careless listing of the session would miss. */
  type SubtleChange = readonly [what: string, before: string, asked: string, meanwhile: string];

  const SUBTLE_CHANGES: readonly SubtleChange[] = [
    ['a value holding a newline, not another variable', 'export A="x\nB=y"', `${FORCE_PUSH}; rm -r b`, 'export A=x; export B=y'],
    ['a variable of a session that splits words on another separator', 'export IFS=:; export TARGET=a', `${FORCE_PUSH}; rm -r "$TARGET"`, 'export TARGET=b'],
    ...['__n', '__v'].map((helper): SubtleChange => [
      `a variable named as the read's own ${helper}`, `export ${helper}=a`, `${FORCE_PUSH}; rm -r "$${helper}"`, `export ${helper}=b`,
    ]),
    ['a variable named as a positional parameter', 'export 0=a', `${FORCE_PUSH}; rm -r "$0"`, 'export 0=b'],
    ['a variable whose name no shell word can spell', 'export A-B=a', `${FORCE_PUSH}; rm -r "$(env | sed -n 's/^A-B=//p')"`, 'export A-B=b'],
  ];

  test.each(SUBTLE_CHANGES)('sees %s: the approval does not run on the changed session', async (_what, before, asked, meanwhile) => {
    const { again, workspace } = await approveAcrossAChange(before, asked, meanwhile);

    expect(again.exitCode).not.toBe(0);
    expect(await workspace.fs.exists('/home/main/b')).toBe(true);
  });
});
