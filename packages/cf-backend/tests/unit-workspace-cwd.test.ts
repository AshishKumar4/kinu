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
