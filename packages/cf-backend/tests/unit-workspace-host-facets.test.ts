/**
 * A hosted workspace's `git clone` reaches its facet and `npm install` streams, through the production `createHostedWorkspace`.
 * `@nimbus-sh/platform` holds one composition and one `ctx.exports` per isolate, first write wins, so `../src/server`
 * loads before any workspace (defends a `NIMBUS_SESSION` composition beating `HOST_FABRIC_COMPOSITION`), and every ctx
 * here carries the script's one exports object (`SCRIPT_EXPORTS`), as workerd gives every object of a script.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { git, gitEnv, initRepo, scratchDir, spawnTest } from '@kinu.run/test-utils';
import { createHostedWorkspace, type HostedWorkspace, type HostedWorkspaceEnv } from '../src/workspace-host';
import {
  actorObjectState, durableObjectStorage, durableSqlStorage, durableStorage, HELD_NIMBUS_TASKS, OBJECT_NAMESPACE, SCRIPT_EXPORTS, serveObject,
} from './helpers/programmatic-host';
import { asFetchFunction } from '@kinu.run/core';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { nimbusAssets } from './helpers/nimbus-assets';

// Dynamic so the `agents` stand-in is registered first.
mockAgentsSdk();

await import('../src/server');

/** A script's exports: this script's, or one whose Worker exports no supervisor entrypoint. */
type ScriptExports = Partial<typeof SCRIPT_EXPORTS>;

type ActorBindings = HostedWorkspaceEnv<string>;

const FacetEnvSchema = v.looseObject({
  SUPERVISOR: v.optional(v.instance(SupervisorRPC)),
});

interface DispatchedOp {
  readonly op: string;
  readonly pid: number | undefined;
  readonly mutationOwner: string | undefined;
}

const REFUSAL = 'SupervisorRPC binding not available';

const ACTOR_ID = 'facets-actor-0123456789abcdef';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** A Durable Object's ctx carrying its script's `exports`. */
function actorCtx(exports: ScriptExports): DurableObjectState {
  const database = new Database(':memory:');
  databases.push(database);

  const storage = durableObjectStorage({
    sql: durableSqlStorage(database),
    transactionSync: <T,>(closure: () => T): T => database.transaction(closure)(),
    ...durableStorage(new Map()),
  });

  const base = {
    storage,
    id: { toString: () => ACTOR_ID, equals: () => false, name: ACTOR_ID },
    waitUntil: () => {},
    getWebSockets: () => [],
  };

  return actorObjectState({ ...base, exports });
}

interface Actor {
  readonly hosted: HostedWorkspace;
  readonly facetLoads: { readonly supervisorBound: boolean }[];
  readonly dispatched: DispatchedOp[];
}

/**
 * The host namespace is the deployment's `OrchestratorAgent` binding, never `NIMBUS_SESSION`. `duringFacet` runs as the
 * facet's own code would, with its `SUPERVISOR` binding, while the facet's process is live.
 */
function hostActor(duringFacet?: (supervisor: SupervisorRPC) => Promise<void>): Actor {
  const facetLoads: { supervisorBound: boolean }[] = [];
  const dispatched: DispatchedOp[] = [];

  const loader = {
    load(code: WorkerLoaderWorkerCode) {
      const source = v.parse(v.pipe(v.string(), v.nonEmpty()), code.modules['git-network-worker.js']);
      const facetEnv = v.parse(FacetEnvSchema, code.env);
      facetLoads.push({ supervisorBound: facetEnv.SUPERVISOR !== undefined });
      const dir = scratchDir('host-facet');
      writeFileSync(join(dir, 'git-network-worker.mjs'), source);
      writeFileSync(join(dir, 'git-bundle.js'), v.parse(v.pipe(v.string(), v.nonEmpty()), code.modules['git-bundle.js']));
      const moduleUrl = pathToFileURL(join(dir, 'git-network-worker.mjs')).href;
      let loaded: Promise<unknown> | undefined;

      return {
        getEntrypoint: () => ({
          fetch: async (request: Request) => {
            loaded ??= import(moduleUrl);
            const facet = v.parse(v.object({ default: v.object({ fetch: v.function() }) }), await loaded);

            if (duringFacet !== undefined && facetEnv.SUPERVISOR !== undefined) await duringFacet(facetEnv.SUPERVISOR);

            return v.parse(v.instance(Response), await facet.default.fetch(request, facetEnv));
          },
        }),
      };
    },
    get() { throw new Error('no cached worker is served by this host'); },
  };

  // Unchecked: `WorkerLoader` is a workerd binding with no constructible form, and the fabric reaches only `load`.
  const LOADER: WorkerLoader = Object.create(loader);

  const ASSETS = {
    fetch: async (input: RequestInfo | URL) => nimbusAssets(input instanceof Request ? input : new Request(input)),
    connect: (): never => { throw new Error('ASSETS.connect: not reachable in this test'); },
  };

  const actorEnv: ActorBindings = { LOADER, OrchestratorAgent: OBJECT_NAMESPACE, ASSETS };

  const hosted = createHostedWorkspace({
    tasks: HELD_NIMBUS_TASKS,
    ctx: actorCtx(SCRIPT_EXPORTS),
    env: actorEnv,
    previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
  });

  // What the namespace resolves this object's id to: a facet's supervisor reaches the workspace only through here.
  serveObject(ACTOR_ID, {
    supervisorOp: (envelope) => {
      dispatched.push({ op: envelope.op, pid: envelope.pid, mutationOwner: envelope.mutationOwner });

      return hosted.supervisorOp(envelope);
    },
  });

  return { hosted, facetLoads, dispatched };
}

/**
 * `https://example.invalid/hello.git`, served as git's smart HTTP serves a repository (git http-backend): `git upload-pack`
 * over a real one-commit repository, so the facet's own pack client clones it as it would GitHub's.
 */
let hello: Promise<string> | undefined;

async function helloRepository(): Promise<string> {
  const work = scratchDir('hello-repo');

  await initRepo(work);
  await git(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), '# hello from the facet\n');
  await git(work, 'add', 'README.md');
  await git(work, 'commit', '-q', '-m', 'hello');

  return join(work, '.git');
}

const packet = (text: string): string => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;

async function uploadPack(request: Request): Promise<Response> {
  const advertise = new URL(request.url).pathname.endsWith('/info/refs');
  const repository = await (hello ??= helloRepository());

  const ran = spawnTest(['git', 'upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), repository], {
    env: gitEnv(), stdin: advertise ? 'ignore' : new Uint8Array(await request.arrayBuffer()), stdout: 'pipe', stderr: 'pipe',
  });

  const body = new Uint8Array(await new Response(ran.stdout).arrayBuffer());

  if (await ran.exited !== 0) return new Response(`upload-pack failed: ${await new Response(ran.stderr).text()}`, { status: 500 });

  if (!advertise) return new Response(body, { headers: { 'content-type': 'application/x-git-upload-pack-result' } });

  return new Response(new Blob([`${packet('# service=git-upload-pack\n')}0000`, body]), {
    headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = new Request(input, init);

    return new URL(request.url).hostname === 'example.invalid' ? uploadPack(request) : originalFetch(request);
  });
});

afterEach(() => { globalThis.fetch = originalFetch; });

function refusingBindings(): ActorBindings {
  const spawned = (): never => { throw new Error('no facet may spawn'); };

  return {
    NIMBUS_RUNTIME_CACHE: undefined,
    ASSETS: undefined,
    // The platform's `WorkerLoader` declaration omits `load`, which the facet manager checks for.
    LOADER: Object.assign({ get: spawned }, { load: spawned }),
    OrchestratorAgent: {
      idFromName: (name) => name,
      idFromString: (id) => id,
      get() { throw new Error('no facet may reach a host'); },
    },
  };
}

describe('hosted workspace facets', () => {
  test('a script that exports no supervisor entrypoint composes no runtime: the first command names it', async () => {
    const hosted = createHostedWorkspace({
      tasks: HELD_NIMBUS_TASKS,
      ctx: actorCtx({}),
      env: refusingBindings(),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });

    await expect(hosted.box('red').exec('git clone https://example.invalid/hello.git /home/main/hello'))
      .rejects.toThrow('supervisor entrypoint');
  });

  test('git clone spawns one facet and lands bytes through supervisorOp', async () => {
    const actor = hostActor();
    const clone = await actor.hosted.box('green').exec('git clone https://example.invalid/hello.git /home/main/hello');
    const output = `${clone.stdout}${clone.stderr}`;
    expect(output).not.toContain(REFUSAL);
    expect(clone.exitCode).toBe(0);

    expect(actor.facetLoads.length).toBe(1);
    expect(actor.facetLoads[0]?.supervisorBound).toBe(true);
    // Ops land here only if the facet's binding named this object's id: the namespace resolves hosts by id.
    expect(actor.dispatched.length).toBeGreaterThan(0);

    for (const call of actor.dispatched) {
      expect(Number.isInteger(call.pid) && (call.pid ?? 0) > 0).toBe(true);
    }

    const byOp = new Map<string, number>();

    for (const call of actor.dispatched) byOp.set(call.op, (byOp.get(call.op) ?? 0) + 1);
    expect(byOp.get('writeBatchStream') ?? 0).toBeGreaterThan(0);
    const writeOp = actor.dispatched.find((call) => call.op === 'writeBatchStream');
    expect(writeOp?.mutationOwner).toBeString();

    const session = await actor.hosted.bundle.session();
    const vfs = session.vfs.as(CRED_SESSION_USER);
    expect(vfs.readFile('home/main/hello/.git/HEAD')).toEqual(new TextEncoder().encode('ref: refs/heads/main\n'));
    expect(vfs.readFile('home/main/hello/README.md')).toEqual(new TextEncoder().encode('# hello from the facet\n'));
  });
});

/**
 * What a facet's own code can put on the wire: over RPC every method on an entrypoint's prototype is callable (only
 * instance properties are private), so `_fsOp` sends any op name, stamped with the binding's own pid.
 */
async function fsOp(supervisor: SupervisorRPC, op: string, args: readonly string[]): Promise<boolean> {
  // Any op name at all, as the wire carries it: a method's parameters are compared both ways.
  const wire: { _fsOp<T>(name: string, values: readonly string[]): Promise<T> } = supervisor;

  return v.parse(v.boolean(), await wire._fsOp<boolean>(op, args));
}

describe('a hosted process is untrusted code: the host serves only what Nimbus serves', () => {
  test.each(['somethingElse', 'constructor', 'toString'])('an op named %p is refused at the host, which writes nothing', async (op) => {
    let known: boolean | undefined;

    const actor = hostActor(async (supervisor) => {
      known = await fsOp(supervisor, 'exists', ['/home/main']);
      await expect(fsOp(supervisor, op, ['/home/main/untrusted.txt', 'written'])).rejects.toThrow();
    });

    const clone = await actor.hosted.box('untrusted').exec('git clone https://example.invalid/hello.git /home/main/hello');

    expect(clone.exitCode).toBe(0);
    // The same wire path serves an op Nimbus knows, so the refusal is about the name.
    expect(known).toBe(true);
    // It crossed to the host: the refusal is the host's, not the facet's own.
    expect(actor.dispatched.map((call) => call.op)).toContain(op);
    const vfs = (await actor.hosted.bundle.session()).vfs.as(CRED_SESSION_USER);
    expect(vfs.exists('home/main/untrusted.txt')).toBe(false);
  });

  test("a hosted process's file mutation, delivered once, lands in the workspace", async () => {
    // Inside the clone's own tree: a git facet's mutations are confined to its destination (Nimbus 0.14).
    const actor = hostActor(async (supervisor) => { await supervisor.mkdir('/home/main/hello/delivered', { recursive: true }); });

    const clone = await actor.hosted.box('delivered').exec('git clone https://example.invalid/hello.git /home/main/hello');

    expect(clone.exitCode).toBe(0);
    // Worker 0.11 sends a mutation as `deliverOnce` wherever the host keeps receipts, which the hosted runtime does.
    expect(actor.dispatched.map((call) => call.op)).toContain('deliverOnce');
    const vfs = (await actor.hosted.bundle.session()).vfs.as(CRED_SESSION_USER);
    expect(vfs.isDirectory('home/main/hello/delivered')).toBe(true);
  });
});

describe('hosted file reads report absence by code, not by message', () => {
  test('a non-absence failure still throws when its path contains ENOENT', async () => {
    // `ENOENT-probe` guards reading the VFS `code` rather than matching the message (EISDIR's text holds the substring).
    const actor = hostActor();
    const files = actor.hosted.box('probe').store({ home: '/home/main' });

    await files.mkdir('/home/main/ENOENT-probe');
    await expect(files.readFile('/home/main/ENOENT-probe')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(files.readFile('/home/main/no-such-file')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
