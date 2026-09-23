/**
 * A hosted workspace's `git clone` reaches its facet and `npm install` streams, through the production `createHostedWorkspace`.
 * `@nimbus-sh/platform` holds one composition and one `ctx.exports` per isolate, first write wins, so `../src/server`
 * loads before any workspace (defends a `NIMBUS_SESSION` composition beating `HOST_FABRIC_COMPOSITION`), and every ctx
 * here carries the script's one exports object (`SCRIPT_EXPORTS`), as workerd gives every object of a script.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { createHostedWorkspace, type HostedWorkspace, type HostedWorkspaceEnv } from '../src/workspace-host';
import {
  actorObjectState, durableObjectStorage, durableSqlStorage, durableStorage, OBJECT_NAMESPACE, SCRIPT_EXPORTS, serveObject,
} from './helpers/programmatic-host';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SupervisorRPC } from '@nimbus-sh/worker/workspace-host';
import { mockAgentsSdk } from './helpers/agents-sdk';

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

/** The host namespace is the deployment's `OrchestratorAgent` binding, never `NIMBUS_SESSION`. */
function hostActor(): Actor {
  const facetLoads: { supervisorBound: boolean }[] = [];
  const dispatched: DispatchedOp[] = [];

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
    get() { throw new Error('no cached worker is served by this host'); },
  };

  // Unchecked: `WorkerLoader` is a workerd binding with no constructible form, and the fabric reaches only `load`.
  const LOADER: WorkerLoader = Object.create(loader);

  const actorEnv: ActorBindings = { LOADER, OrchestratorAgent: OBJECT_NAMESPACE };

  const hosted = createHostedWorkspace({
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

/** Deterministic stand-in for isomorphic-git's network half, writing through the facet's buffered fs adapter. */
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

    // Every `SUPERVISOR_OPS` name is served, so only wire data outside the type can reach this refusal.
    const unserved = actor.hosted.supervisorOp({ op: 'somethingElse', args: [] });
    await expect(unserved).rejects.toThrow("supervisor op: 'somethingElse' names no operation this host serves");
    await expect(unserved).rejects.toMatchObject({ code: 'bad_input' });

    const session = await actor.hosted.bundle.session();
    const vfs = session.vfs.as(CRED_SESSION_USER);
    expect(vfs.readFile('home/main/hello/.git/HEAD')).toEqual(new TextEncoder().encode('ref: refs/heads/main\n'));
    expect(vfs.readFile('home/main/hello/README.md')).toEqual(new TextEncoder().encode('# hello from the facet\n'));
  });
});

describe('hosted file reads report absence by code, not by message', () => {
  test('a non-absence failure still throws when its path contains ENOENT', async () => {
    // `/ENOENT-probe` guards reading the VFS `code` rather than matching the message (EISDIR's text holds the substring).
    const actor = hostActor();
    const files = actor.hosted.box('probe').files;

    if (!files) throw new Error('the hosted box carries no files plane');

    if (!files.mkdir) throw new Error('the hosted files plane carries no mkdir');
    await files.mkdir('/ENOENT-probe');
    await expect(files.read('/ENOENT-probe')).rejects.toThrow('EISDIR');
    await expect(files.read('/no-such-file')).resolves.toBeNull();
  });
});
