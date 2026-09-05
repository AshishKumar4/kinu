/**
 * A HOSTED workspace's `git clone` reaches its facet, and its `npm install`
 * streams.
 *
 * Driven through the production `createHostedWorkspace` — not a shim of it —
 * over a fake Durable Object ctx carrying `.exports` (the REAL `SupervisorRPC`
 * class over the preload's `cloudflare:workers` stub) plus a fake `env.LOADER`
 * that materialises the assembled facet module. The clone's network half is
 * stubbed (the `git-bundle.js` the facet imports), so the suite is hermetic;
 * everything else is real: the workspace, the SqliteVFS the clone writes
 * into, the shell `git` command, the clone driver (`execGitNetwork`), the
 * assembled facet module invoked through `fetch` exactly as `LOADER.load()`
 * hands it back, the supervisor entrypoint, and the W7 write waves.
 *
 * ORDER MATTERS in this file, twice. `@nimbus-sh/platform` holds the fabric
 * composition and the adopted `ctx.exports` in two first-write-wins singletons
 * with no reset. So the Worker entry (`../src/server`) is loaded before any
 * workspace, as production evaluates it: its re-export of `SupervisorRPC` once
 * reached `@nimbus-sh/worker`'s root, whose module scope composes the HOSTED
 * product's fabric — no `hostNamespace`, so `NIMBUS_SESSION` — and that write
 * beat the host's own `HOST_FABRIC_COMPOSITION`; every clone then asked for a
 * namespace this Worker does not bind. Alone, this suite was green over that
 * defect. And the refusal test runs FIRST, before any workspace adopts an
 * exports bag; move it after and the red direction cannot fire.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { createHostedWorkspace, type HostedWorkspace } from '../src/workspace-host';
import type { SupervisorOpResult } from '@kinu.run/core/workspace';
import { CRED_SESSION_USER, type SqlRow, type SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { SupervisorRPC } from '../../../node_modules/@nimbus-sh/worker/dist/session/supervisor-rpc.js';
import { mockAgentsSdk } from './helpers/agents-sdk';

// The entry's module graph reaches `agents`, which the harness stands in for;
// the load is dynamic so the stand-in is registered first.
mockAgentsSdk();
await import('../src/server');

type SupervisorProps = { doId: string; pid: number; writerId?: string; mutationOwner?: string };
type SupervisorBinding = InstanceType<typeof SupervisorRPC>;

/** The bag workerd hangs on a Durable Object's `ctx`, reduced to the one entry
 *  the fabric reads: the composed supervisor entrypoint, which mints one
 *  binding per hosted program. */
interface ActorExports {
  readonly SupervisorRPC: (binding: { readonly props: SupervisorProps }) => SupervisorBinding;
}

/** The namespace the supervisor entrypoint resolves its host in. Its objects
 *  mount the one method production mounts. */
interface WorkspaceHostNamespace {
  idFromString(id: string): string;
  get(id: string): { supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult> };
}

/** The two bindings a hosted workspace and its supervisor entrypoint read. */
interface ActorBindings {
  readonly LOADER: WorkerLoader;
  readonly OrchestratorAgent: WorkspaceHostNamespace;
}

/** What the fabric hands a facet as its env: the supervisor binding it minted,
 *  beside whatever else the assembled boot carries. */
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

/** The filesystem binds BLOBs as ArrayBuffer; bun:sqlite binds only TypedArrays. */
function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

/**
 * One Durable Object's storage, as the platform gives it: a real SQLite
 * database with a real `transactionSync`. `exports` is the bag workerd hangs
 * on `ctx` — present for the actor under test, absent for the red direction.
 */
function actorCtx(exports?: ActorExports): DurableObjectState {
  const database = new Database(':memory:');
  databases.push(database);
  const storage = {
    sql: {
      exec(query: string, ...bindings: SqlValue[]) {
        const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
        const bound = bindings.map(sqlBinding);
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
        statement.run(...bound);
        return [];
      },
    },
    transactionSync: <T,>(closure: () => T): T => database.transaction(closure)(),
    get: async () => undefined,
    put: async () => {},
    delete: async () => true,
    deleteAll: async () => {},
    deleteAlarm: async () => {},
  };
  const context = {
    storage,
    id: { toString: () => ACTOR_ID, name: ACTOR_ID },
    waitUntil: () => {},
    getWebSockets: () => [],
  };
  // Unchecked and named: the members above are exactly what
  // `createHostedWorkspace` reads, and any other access throws by name.
  const ctx: DurableObjectState = Object.create(context);
  if (exports !== undefined) Object.assign(ctx, { exports });
  return ctx;
}

interface Actor {
  readonly hosted: HostedWorkspace;
  readonly facetLoads: { readonly supervisorBound: boolean }[];
  readonly supervisorBindings: SupervisorProps[];
  readonly dispatched: DispatchedOp[];
}

/**
 * The hosted workspace inside its actor, with the two halves a facet needs:
 * an exports bag minting REAL supervisor bindings, and a LOADER running the
 * REAL assembled facet module against a stubbed git bundle.
 *
 * The host namespace is the deployment's own `OrchestratorAgent` binding —
 * never `NIMBUS_SESSION` — and the object it resolves to mounts the one
 * method production mounts, forwarding to the hosted workspace exactly as
 * `OrchestratorAgent.supervisorOp` does.
 */
function hostActor(): Actor {
  const facetLoads: { supervisorBound: boolean }[] = [];
  const supervisorBindings: SupervisorProps[] = [];
  const dispatched: DispatchedOp[] = [];
  // Set by `createHostedWorkspace` below; the namespace object closes over
  // the cell the way the orchestrator closes over its own hosted workspace.
  let hosted: HostedWorkspace | undefined;
  const loader = {
    load(code: WorkerLoaderWorkerCode) {
      const source = v.parse(v.pipe(v.string(), v.nonEmpty()), code.modules['git-network-worker.js']);
      const facetEnv = v.parse(FacetEnvSchema, code.env);
      facetLoads.push({ supervisorBound: facetEnv.SUPERVISOR !== undefined });
      const dir = scratchDir('host-facet');
      writeFileSync(join(dir, 'git-network-worker.mjs'), source);
      writeFileSync(join(dir, 'git-bundle.js'), GIT_BUNDLE_STUB);
      const moduleUrl = pathToFileURL(join(dir, 'git-network-worker.mjs')).href;
      let loaded: Promise<unknown> | undefined;
      return {
        getEntrypoint: () => ({
          fetch: async (request: Request) => {
            loaded ??= import(moduleUrl);
            const facet = v.parse(v.object({ default: v.object({ fetch: v.function() }) }), await loaded);
            return v.parse(v.instance(Response), await facet.default.fetch(request, facetEnv));
          },
        }),
      };
    },
  };
  // Unchecked and named: `WorkerLoader` is a workerd binding with no
  // constructible form, and the fabric reaches only `load`. The double rides
  // the prototype the way helpers/jsrpc-stub.ts builds stubs.
  const LOADER: WorkerLoader = Object.create(loader);
  const actorEnv: ActorBindings = {
    LOADER,
    OrchestratorAgent: {
      idFromString: (id) => id,
      get: (id) => {
        if (id !== ACTOR_ID) throw new Error('supervisor resolved the wrong host');
        return {
          supervisorOp: (envelope) => {
            if (hosted === undefined) throw new Error('facet arrived before the workspace');
            dispatched.push({ op: envelope.op, pid: envelope.pid, mutationOwner: envelope.mutationOwner });
            return hosted.supervisorOp(envelope);
          },
        };
      },
    },
  };
  const exports: ActorExports = {
    SupervisorRPC: ({ props }: { props: SupervisorProps }) => {
      supervisorBindings.push(props);
      return new SupervisorRPC({
        props,
        waitUntil: () => { throw new Error('unexpected supervisor background work'); },
        passThroughOnException: () => { throw new Error('unexpected supervisor pass-through'); },
      }, actorEnv);
    },
  };
  // The ctx the workspace is composed over IS the ctx carrying `.exports` —
  // in a Durable Object that object is one and the same, and the adoption
  // reads it off `transactions`.
  hosted = createHostedWorkspace({
    ctx: actorCtx(exports),
    env: strictEnv(actorEnv),
    previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
  });
  return { hosted, facetLoads, supervisorBindings, dispatched };
}

/**
 * An Env that answers only what it was told to, and names anything else. A
 * hosted workspace that reached for a session binding would previously have
 * found a fake and passed; here it finds a throw carrying the property name.
 */
function strictEnv(bindings: ActorBindings): Env {
  // The runtime catalogue binding is optional and read on every boot.
  const served = new Map<string, WorkerLoader | WorkspaceHostNamespace | undefined>([
    ['LOADER', bindings.LOADER],
    ['OrchestratorAgent', bindings.OrchestratorAgent],
    ['NIMBUS_RUNTIME_CACHE', undefined],
  ]);
  const target: Env = Object.create(null);
  return new Proxy(target, {
    get(_target, property: string) {
      if (served.has(property)) return served.get(property);
      throw new Error('the hosted workspace read env.' + property + ', which this deployment does not bind');
    },
    has: (_target, property: string) => served.has(property),
  });
}

/**
 * The git bundle the facet imports. Deterministic stand-in for
 * isomorphic-git's network half: it writes a pack, an index, a HEAD and a ref
 * through the facet's own buffered fs adapter, which is what turns into W7
 * waves against the host.
 */
const GIT_BUNDLE_STUB = `
const enc = new TextEncoder();
export const gitHttp = {};
export const git = {
  async clone({ fs, dir, cache, ref }) {
    const root = dir.replace(/^\\/+/, '');
    const packDir = root + '/.git/objects/pack';
    const pack = new Uint8Array(4096);
    for (let i = 0; i < pack.length; i++) pack[i] = (i * 31 + 7) & 0xff;
    await fs.promises.mkdir(packDir);
    await fs.promises.writeFile(packDir + '/pack-${'3'.repeat(40)}.pack', pack);
    await fs.promises.writeFile(packDir + '/pack-${'3'.repeat(40)}.idx', enc.encode('idx'));
    await fs.promises.mkdir(root + '/.git/refs/heads');
    await fs.promises.writeFile(root + '/.git/HEAD', 'ref: refs/heads/' + (ref || 'main') + '\\n');
    await fs.promises.writeFile(root + '/.git/refs/heads/' + (ref || 'main'), '${'1'.repeat(40)}' + '\\n');
    cache.prepared = true;
  },
  async resolveRef() { return '${'1'.repeat(40)}'; },
  async readCommit() { return { commit: { tree: '${'2'.repeat(40)}' } }; },
  async currentBranch() { return 'refs/heads/main'; },
  async checkoutFreshChunk({ fs, dir }) {
    const root = dir.replace(/^\\/+/, '');
    await fs.promises.writeFile(root + '/README.md', '# hello from the facet\\n');
    return { nextCursor: null, files: 1, decodedBytes: 23, treeEntriesVisited: 1, indexEntries: 1 };
  },
};
`;

/** One USTAR file entry: a 512-byte header plus padded content. */
function tarFile(name: string, data: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(data);
  const header = new Uint8Array(512);
  const octal = (value: number, width: number): string =>
    value.toString(8).padStart(width - 1, '0') + '\0';
  const write = (offset: number, value: string, width: number): void => {
    header.set(new TextEncoder().encode(value).subarray(0, width), offset);
  };
  write(0, name, 100);
  write(100, octal(0o644, 8), 8);
  write(108, octal(0, 8), 8);
  write(116, octal(0, 8), 8);
  write(124, octal(bytes.length, 12), 12);
  write(136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  write(257, 'ustar\0', 6);
  write(263, '00', 2);
  write(148, octal(header.reduce((sum, byte) => sum + byte, 0), 8), 8);
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return [header, padded];
}

const REGISTRY_PKG = 'host-fixture';
const REGISTRY_VERSION = '1.0.0';
const REGISTRY_MANIFEST = `{"name":"${REGISTRY_PKG}","version":"${REGISTRY_VERSION}","main":"lib/index.js"}`;
// package.json FIRST in the archive, as npm ships it. The streaming writer
// holds the manifest back and lands it last, so a tree without one is a tree
// the next install re-extracts rather than trusts.
const REGISTRY_TARBALL = (() => {
  const parts = [
    ...tarFile('package/package.json', REGISTRY_MANIFEST),
    ...tarFile('package/lib/index.js', 'module.exports = 1;\n'),
    new Uint8Array(1024),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return new Uint8Array(gzipSync(out));
})();

interface LocalRegistry {
  readonly url: string;
  stop(): Promise<void>;
}

function serveRegistry(): LocalRegistry {
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const { pathname } = new URL(request.url);
      if (pathname === `/${REGISTRY_PKG}/latest` || pathname === `/${REGISTRY_PKG}/${REGISTRY_VERSION}`) {
        return Response.json({
          name: REGISTRY_PKG,
          version: REGISTRY_VERSION,
          dist: {
            tarball: `http://127.0.0.1:${server.port}/${REGISTRY_PKG}/-/${REGISTRY_PKG}-${REGISTRY_VERSION}.tgz`,
          },
        });
      }
      if (pathname === `/${REGISTRY_PKG}/-/${REGISTRY_PKG}-${REGISTRY_VERSION}.tgz`) {
        return new Response(REGISTRY_TARBALL, {
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Bindings for the red direction: nothing may spawn and nothing may reach a host. */
function refusingBindings(): ActorBindings {
  const loader = {
    load() { throw new Error('no facet may spawn'); },
  };
  // Unchecked and named: see `hostActor`.
  const LOADER: WorkerLoader = Object.create(loader);
  return {
    LOADER,
    OrchestratorAgent: {
      idFromString: (id) => id,
      get() { throw new Error('no facet may reach a host'); },
    },
  };
}

describe('hosted workspace facets', () => {
  test('a ctx without exports still answers the verbatim refusal', async () => {
    const hosted = createHostedWorkspace({
      ctx: actorCtx(),
      env: strictEnv(refusingBindings()),
      previewUrl: async () => ({ unavailable: 'no preview host in this test' }),
    });
    const clone = await hosted.box('red').exec('git clone https://example.invalid/hello.git /home/user/hello');
    const output = `${clone.stdout}${clone.stderr}`;
    expect(clone.exitCode).toBe(1);
    expect(output).toContain(REFUSAL);
  });

  test('git clone spawns one facet and lands bytes through supervisorOp', async () => {
    const actor = hostActor();
    const clone = await actor.hosted.box('green').exec('git clone https://example.invalid/hello.git /home/user/hello');
    const output = `${clone.stdout}${clone.stderr}`;
    expect(output).not.toContain(REFUSAL);
    expect(clone.exitCode).toBe(0);

    // The facet path was taken, and it carried a SUPERVISOR binding.
    expect(actor.facetLoads.length).toBe(1);
    expect(actor.facetLoads[0]?.supervisorBound).toBe(true);
    // Every binding the supervisor minted named this host and this process.
    expect(actor.supervisorBindings.length).toBeGreaterThan(0);
    for (const props of actor.supervisorBindings) {
      expect(props.doId).toBe(ACTOR_ID);
      expect(Number.isInteger(props.pid) && props.pid > 0).toBe(true);
    }
    // Every filesystem call arrived through the ONE method the host mounts,
    // stamped with the process behind it.
    expect(actor.dispatched.length).toBeGreaterThan(0);
    for (const call of actor.dispatched) {
      expect(Number.isInteger(call.pid) && (call.pid ?? 0) > 0).toBe(true);
    }
    const byOp = new Map<string, number>();
    for (const call of actor.dispatched) byOp.set(call.op, (byOp.get(call.op) ?? 0) + 1);
    expect(byOp.get('writeBatchStream') ?? 0).toBeGreaterThan(0);
    const writeOp = actor.dispatched.find((call) => call.op === 'writeBatchStream');
    expect(writeOp?.mutationOwner).toBeString();

    // An operation this host does not serve does not exist.
    await expect(actor.hosted.supervisorOp({ op: 'somethingElse', args: [] }))
      .rejects.toThrow('is not served by this host');

    // The bytes landed in the actor's OWN filesystem.
    const session = await actor.hosted.bundle.session();
    const vfs = session.vfs.as(CRED_SESSION_USER);
    expect(vfs.readFile('home/user/hello/.git/HEAD')).toEqual(new TextEncoder().encode('ref: refs/heads/main\n'));
    expect(vfs.readFile('home/user/hello/README.md')).toEqual(new TextEncoder().encode('# hello from the facet\n'));
  });

  test('npm install streams a package off a local registry into the workspace', async () => {
    const registry = serveRegistry();
    try {
      const actor = hostActor();
      const box = actor.hosted.box('npm');
      const made = await box.exec('mkdir -p /home/user/proj');
      expect(made.exitCode).toBe(0);
      const install = await box.exec(`cd /home/user/proj && npm install ${REGISTRY_PKG}`, {
        env: { NPM_REGISTRY: registry.url },
      });
      const output = `${install.stdout}${install.stderr}`;
      expect(output).not.toContain(REFUSAL);
      expect(install.exitCode).toBe(0);
      const session = await actor.hosted.bundle.session();
      const vfs = session.vfs.as(CRED_SESSION_USER);
      const manifestPath = `home/user/proj/node_modules/${REGISTRY_PKG}/package.json`;
      expect(vfs.readFile(manifestPath)).toEqual(new TextEncoder().encode(REGISTRY_MANIFEST));
      expect(vfs.readFile('home/user/proj/node_modules/' + REGISTRY_PKG + '/lib/index.js'))
        .toEqual(new TextEncoder().encode('module.exports = 1;\n'));
    } finally {
      await registry.stop();
    }
  });
});

describe('hosted file reads report absence by code, not by message', () => {
  test('a non-absence failure still throws when its path contains ENOENT', async () => {
    // The read helper matched the rendered message, so reading a directory
    // named `/ENOENT-probe` answered `null` (EISDIR's text holds the
    // substring) while any other directory threw. The tolerance now reads the
    // VFS `code`.
    const actor = hostActor();
    const files = actor.hosted.box('probe').files;
    if (!files) throw new Error('the hosted box carries no files plane');
    if (!files.mkdir) throw new Error('the hosted files plane carries no mkdir');
    await files.mkdir('/ENOENT-probe');
    await expect(files.read('/ENOENT-probe')).rejects.toThrow('EISDIR');
    await expect(files.read('/no-such-file')).resolves.toBeNull();
  });
});
