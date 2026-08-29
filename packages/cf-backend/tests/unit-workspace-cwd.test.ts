import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import * as v from 'valibot';
import { Nimbus, type NimbusExecOptions } from '@nimbus-sh/sdk';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase, SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import {
  ensureProgrammaticReady,
  rpcExec,
  rpcExposePort,
  rpcListPorts,
  rpcRouteCapabilityPort,
  rpcUnexposePort,
  type ProgrammaticExecOptions,
  type ProgrammaticHost,
} from '../../../node_modules/@nimbus-sh/worker/dist/session/programmatic.js';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

interface WorkspaceDatabase {
  readonly database: Database;
  readonly sql: SqlDatabase;
}

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

function openWorkspaceDatabase(): WorkspaceDatabase {
  const database = new Database(':memory:');
  databases.push(database);
  return {
    database,
    sql: {
      exec(query: string, ...bindings: SqlValue[]) {
        const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
        const bound = bindings.map(sqlBinding);
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
        statement.run(...bound);
        return [];
      },
    },
  };
}

type DurableShellState = Map<string, unknown>;

function workerHost(workspace: NimbusWorkspace, durableState: DurableShellState): ProgrammaticHost {
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
    _rpcListPorts: () => rpcListPorts(host),
    _rpcExposePort: (port: number) => rpcExposePort(host, port),
    _rpcUnexposePort: (port: number) => rpcUnexposePort(host, port),
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: () => stub,
  };
  return Nimbus.fromEnv({ NIMBUS_SESSION: namespace }).sandbox('workspace', { root: '/home/user' });
}

const shell = (shellId: string): NimbusExecOptions => ({ shellId });

describe('hosted workspace actor shell state', () => {
  test('successive public SDK calls keep cwd over the authoritative VFS bytes', async () => {
    const { database, sql } = openWorkspaceDatabase();
    const workspace = await NimbusWorkspace.create({
      sql,
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
      generation: 1,
    });
    await workspace.fs.mkdir('/home/user/repo', { recursive: true });
    await workspace.fs.writeFile('/home/user/repo/proof.txt', 'same bytes');

    const box = sdkBox(workerHost(workspace, new Map()));
    expect(await box.exec('cd repo', shell('agent:main'))).toMatchObject({ exitCode: 0 });
    expect(await box.exec('pwd', shell('agent:main'))).toMatchObject({
      stdout: '/home/user/repo\n',
      exitCode: 0,
    });
    expect(await box.exec('cat proof.txt', shell('agent:main'))).toMatchObject({
      stdout: 'same bytes',
      exitCode: 0,
    });
    expect(await workspace.fs.readFile('/home/user/repo/proof.txt')).toBe('same bytes');
  });

  test('concurrent actor shells serialize their own calls without cwd or env leakage', async () => {
    const { database, sql } = openWorkspaceDatabase();
    const workspace = await NimbusWorkspace.create({
      sql,
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
      generation: 1,
    });
    await workspace.fs.mkdir('/home/user/alpha', { recursive: true });
    await workspace.fs.mkdir('/home/user/beta', { recursive: true });
    const box = sdkBox(workerHost(workspace, new Map()));

    const alpha = shell('subordinate:alpha');
    const beta = shell('head:beta');
    const [, alphaPwd] = await Promise.all([
      box.exec('cd /home/user/alpha; export ACTOR=alpha', alpha),
      box.exec('pwd; echo $ACTOR', alpha),
      box.exec('cd /home/user/beta; export ACTOR=beta', beta),
    ]);

    expect(alphaPwd).toMatchObject({ stdout: '/home/user/alpha\nalpha\n', exitCode: 0 });
    expect(await box.exec('pwd; echo $ACTOR', beta)).toMatchObject({
      stdout: '/home/user/beta\nbeta\n',
      exitCode: 0,
    });
  });

  test('durable shell state survives worker reconstruction', async () => {
    const { database, sql } = openWorkspaceDatabase();
    const transactions = {
      storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() },
    };
    const durableState: DurableShellState = new Map();
    const firstWorkspace = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
    await firstWorkspace.fs.mkdir('/home/user/repo', { recursive: true });
    const firstBox = sdkBox(workerHost(firstWorkspace, durableState));
    await firstBox.exec('cd /home/user/repo; export RECONSTRUCTED=yes', shell('agent:main'));

    const reconstructedWorkspace = await NimbusWorkspace.create({ sql, transactions, generation: 2 });
    const reconstructedBox = sdkBox(workerHost(reconstructedWorkspace, durableState));
    expect(await reconstructedBox.exec('pwd; echo $RECONSTRUCTED', shell('agent:main'))).toMatchObject({
      stdout: '/home/user/repo\nyes\n',
      exitCode: 0,
    });
  });
});

describe('hosted workspace preview capabilities', () => {
  test('the public SDK capability reaches the actual worker/core guest route and is revoked on unexpose', async () => {
    const { database, sql } = openWorkspaceDatabase();
    const workspace = await NimbusWorkspace.create({
      sql,
      transactions: { storage: { transactionSync: <T,>(fn: () => T): T => database.transaction(fn)() } },
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
    host.portRegistry.bindFacetStub(41, guest);
    host.portRegistry.register(4321, 41);

    const box = sdkBox(host);
    const exposed = await box.ports.expose(4321);
    expect(exposed.capability).toMatch(/^[a-f0-9]{24}$/);
    if (!exposed.capability) throw new Error('listening port did not receive a capability');

    const response = await rpcRouteCapabilityPort(
      host,
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
    reconstructedHost.portRegistry.bindFacetStub(41, guest);
    reconstructedHost.portRegistry.register(4321, 41);
    expect(reconstructedHost.portRegistry.get(4321)?.capability).not.toBe(exposed.capability);
    expect(await rpcRouteCapabilityPort(
      reconstructedHost,
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
      reconstructedHost,
      4321,
      exposed.capability,
      new Request('https://preview.example/private'),
      '/private',
    )).toMatchObject({ status: 404 });

    reconstructedHost.portRegistry.register(4321, 41);
    const reexposed = await reconstructedBox.ports.expose(4321);
    expect(reexposed.capability).toMatch(/^[a-f0-9]{24}$/);
    expect(reexposed.capability).not.toBe(exposed.capability);
  });

  test('the actual worker route supports Cirrus HMR and generic guest upgrades', async () => {
    const workersModule = await import('cloudflare:workers');
    class WorkerEntrypoint {}
    class DurableObject {}
    class RpcTarget {}
    // Process-wide: retain every preload export a sibling's graph can bind,
    // then replace only the three base classes this route fixture constructs.
    mock.module('cloudflare:workers', () => ({
      ...workersModule, WorkerEntrypoint, DurableObject, RpcTarget,
    }));

    const serverSocket = { serializeAttachment() {} };
    const clientSocket = {};
    class FakeWebSocketPair {
      0 = clientSocket;
      1 = serverSocket;
    }
    Object.defineProperty(globalThis, 'WebSocketPair', {
      configurable: true,
      value: FakeWebSocketPair,
    });

    const { routeCapabilityPort } = await import(
      '../../../node_modules/@nimbus-sh/worker/dist/session/routes.js'
    );
    const { routeHostedWebSocket } = await import(
      '../../../node_modules/@nimbus-sh/worker/dist/session/rpc.js'
    );
    const portRegistry = new PortRegistry();
    portRegistry.bindFacetStub(41, {
      async handleHttpRequest() { return new Response('guest'); },
      async handleWebSocketRequest() { return new Response(null, { status: 101 }); },
    });
    portRegistry.register(4321, 41);
    const capability = portRegistry.get(4321)?.capability;
    if (!capability) throw new Error('port capability was not generated');
    interface TestSocket { serializeAttachment?: () => void }
    const acceptedSockets: TestSocket[] = [];
    let acceptedTags: string[] = [];
    const host = {
      portRegistry,
      _viteShimPort: 4321,
      viteDevServer: null,
      cirrusReal: {
        isRunning: true,
        attachHmrClient(socket: TestSocket) {
          acceptedSockets.push(socket);
          return 'client-1';
        },
      },
      ctx: {
        storage: { get: async () => undefined },
        acceptWebSocket(socket: TestSocket, tags: string[]) {
          acceptedSockets.push(socket);
          acceptedTags = tags;
        },
      },
      _cirrusHmrWsClients: null,
    };
    const hmr = await routeCapabilityPort(
      host,
      4321,
      capability,
      new Request('https://preview.example/__nimbus_hmr', {
        headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr' },
      }),
      '/__nimbus_hmr',
    );
    expect(hmr.status).toBe(101);
    expect(hmr.headers.get('sec-websocket-protocol')).toBe('vite-hmr');
    expect(acceptedSockets).toEqual([serverSocket, serverSocket]);
    expect(acceptedTags).toEqual(['cirrus-hmr']);

    expect(await routeCapabilityPort(
      host,
      4321,
      capability,
      new Request('https://preview.example/socket', { headers: { upgrade: 'websocket' } }),
      '/socket',
    )).toMatchObject({ status: 101 });

    let peerFacetReached = false;
    const peerHost = {
      _hostedProcesses: new Map([['process-key', {
        facet: Promise.resolve({
          async handleWebSocketRequest() {
            peerFacetReached = true;
            return new Response(null, { status: 101 });
          },
        }),
        started: Promise.resolve(),
        webSocketCapability: 'f1a4d4c8-c38d-446e-a10b-e781f15d4ba1',
        cancelled: new Promise<void>(() => {}),
        cancel() {},
      }]]),
      _hostedProcessWaiters: new Map(),
    };
    expect(await routeHostedWebSocket(
      peerHost,
      'process-key',
      '7198774f-fd91-45cf-a1b9-661f77e39221',
      new Request('https://peer.invalid/socket', { headers: { upgrade: 'websocket' } }),
    )).toMatchObject({ status: 404 });
    expect(peerFacetReached).toBe(false);
    expect(await routeHostedWebSocket(
      peerHost,
      'process-key',
      'f1a4d4c8-c38d-446e-a10b-e781f15d4ba1',
      new Request('https://peer.invalid/socket', { headers: { upgrade: 'websocket' } }),
    )).toMatchObject({ status: 101 });
    expect(peerFacetReached).toBe(true);
  });
});
