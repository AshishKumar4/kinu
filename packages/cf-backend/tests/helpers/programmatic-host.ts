/**
 * Nimbus's hosted runtime over a workspace opened in plain bun — the shape
 * `createHostedWorkspace` composes in the Durable Object, held here once so
 * every suite that drives the runtime's verbs over a `NimbusWorkspace` reads
 * the same composition.
 *
 * The runtime is composed over a Durable-Object-shaped ctx (`id`, `storage`,
 * `waitUntil`, `getWebSockets`, and the `exports` bag carrying the REAL
 * `SupervisorRPC`) and the two bindings its constructor reads: the fabric's
 * host namespace, answered by the workspace's own dispatch, and a `LOADER`
 * that no suite here spawns through. Scheduling runs on `waitUntil` directly,
 * because a test file may not arm a timer.
 *
 * `programmaticHostOver` stays synchronous — the composition is awaited by
 * the first verb — so a suite builds its host beside its workspace and asks
 * for readiness exactly as the production box does.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { composeFabric } from '@nimbus-sh/fabric/composition.js';
import {
  composeHostedRuntime, SupervisorRPC, type ComposedFacetManager, type HostedRuntime, type HostedRuntimeTask,
} from '@nimbus-sh/worker/workspace-host';
import type { PortReservationTransaction } from '@nimbus-sh/worker/port-capability';
import * as v from 'valibot';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { NimbusSandboxHandle } from '@kinu.run/core';

export type DurableState = Map<string, unknown>;

/** The transactional view a reservation claim runs against. */
type DurableTransaction = PortReservationTransaction;

/** The Durable Object storage verbs the runtime reads, answered from one map. */
export interface TestDurableStorage extends DurableTransaction {
  transaction<T>(body: (txn: DurableTransaction) => Promise<T>): Promise<T>;
  deleteAll(): Promise<void>;
  deleteAlarm(): Promise<void>;
  sync(): Promise<void>;
}

export function durableStorage(durable: DurableState): TestDurableStorage {
  const list = async (options: { prefix: string }): Promise<Map<string, unknown>> => {
    const entries = new Map<string, unknown>();

    for (const [key, value] of durable) {
      if (key.startsWith(options.prefix)) entries.set(key, value);
    }

    return entries;
  };

  // The platform's `list` is generic in the type its CALLER names, and rows a
  // stand-in holds under one untyped map cannot name it. Assigning the reader
  // over a refusing declaration leaves the platform's signature on the type —
  // where every reader validates what it asked for — and this reader at
  // runtime; a literal would have to claim one type for every row.
  const reads: Omit<DurableTransaction, 'list'> = {
    get: async (key) => durable.get(key),
    put: async (key, value) => { durable.set(key, value); },
    delete: async (key) => durable.delete(key),
  };

  const transactionView: DurableTransaction = Object.assign(
    { list: refusing('DurableObjectStorage')('list') },
    reads,
    { list },
  );

  return {
    ...transactionView,
    deleteAll: async () => { durable.clear(); },
    deleteAlarm: async () => undefined,
    transaction: async (body) => body(transactionView),
    sync: async () => undefined,
  };
}

/**
 * The runtime's verbs, resolved through one lazy composition: the shape the
 * suites drive, with the composition awaited by whichever verb runs first.
 */
export type ProgrammaticHost = Pick<HostedRuntime,
  'ready' | 'exec' | 'startProcess' | 'runCode' | 'listProcesses' | 'killProcess' | 'processLogs'
  | 'listPorts' | 'exposeApp' | 'removeApp' | 'listApps' | 'routeCapabilityPort' | 'ensureRuntimes'
  | 'installRuntime' | 'listRuntimes' | 'spawnWorker' | 'supervisorOp' | 'files' | 'facets'
>;

export interface TestProgrammaticHost {
  readonly host: ProgrammaticHost;
  readonly runtime: () => Promise<HostedRuntime>;
  readonly facetManager: () => Promise<ComposedFacetManager>;
  readonly processes: SessionProcessSupervisor;
  readonly portRegistry: PortRegistry;
  readonly durable: DurableState;
}

export interface ProgrammaticHostSeams {
  /** The durable map both contexts read; shared across hosts to play a reconstructed isolate. */
  readonly durable?: DurableState;
}

/** The filesystem binds BLOBs as ArrayBuffer; bun:sqlite binds only TypedArrays. */
function sqlBinding(value: SqlValue): SQLQueryBindings {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  return v.parse(v.union([v.string(), v.number(), v.bigint(), v.null()]), value);
}

/**
 * Name a member of a platform object this stand-in does not answer.
 *
 * A Durable Object's `ctx` is thirty-odd members and a suite drives five. The
 * rest refusing by name is what keeps "the host read only these" a checked
 * claim rather than a stand-in quietly answering for one.
 */
function refusing(object: string) {
  return (member: string) => (): never => {
    throw new Error(`${object}.${member}: this test's Durable Object does not answer it`);
  };
}

type SqlStorageRow = Record<string, SqlStorageValue>;

/**
 * The rows one `exec` answered, in the cursor's shape.
 *
 * Nimbus reads a cursor by spreading it (`[...sql.exec(…)]`, worker
 * dist/session/hibernation.js:94 and its neighbours), so iteration is the one
 * member that has to be real. The accounting three refuse: bun:sqlite reports
 * no row counts and a number invented here would be read as one.
 */
class DurableSqlRows<T extends SqlStorageRow> {
  private taken = 0;
  constructor(private readonly rows: readonly T[] = []) {}

  *[Symbol.iterator](): IterableIterator<T> {
    yield* this.rows;
  }

  toArray(): T[] {
    return [...this.rows];
  }

  next(): { done?: false; value: T } | { done: true; value?: never } {
    const value = this.rows[this.taken];

    if (value === undefined) return { done: true };
    this.taken += 1;

    return { value };
  }

  one(): T {
    const [only] = this.rows;

    if (only === undefined || this.rows.length !== 1) {
      throw new Error(`SqlStorageCursor.one: the query answered ${String(this.rows.length)} rows`);
    }

    return only;
  }

  raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    return refusing('SqlStorageCursor')('raw')();
  }

  get columnNames(): string[] {
    return refusing('SqlStorageCursor')('columnNames')();
  }

  get rowsRead(): number {
    return refusing('SqlStorageCursor')('rowsRead')();
  }

  get rowsWritten(): number {
    return refusing('SqlStorageCursor')('rowsWritten')();
  }
}

/** The prepared-statement slot of `SqlStorage`. Nothing constructs one: the
 *  platform exposes the class, and `exec` is the whole of what is driven. */
class DurableSqlStatement {}

/**
 * One Durable Object's SQLite over a bun database — the storage half the
 * workspace's filesystem, process logs and shell state all live in.
 */
export function durableSqlStorage(database: Database): SqlStorage {
  const refuse = refusing('SqlStorage');

  return {
    exec<T extends SqlStorageRow>(query: string, ...bindings: SqlValue[]): SqlStorageCursor<T> {
      const statement = database.prepare<T, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);

      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return new DurableSqlRows(statement.all(...bound));
      statement.run(...bound);

      return new DurableSqlRows();
    },
    get databaseSize(): number {
      return refuse('databaseSize')();
    },
    Cursor: DurableSqlRows,
    Statement: DurableSqlStatement,
  };
}

/**
 * What a suite may hand a platform stand-in for one of its members: the
 * platform's own type, or the call this suite answers it with. The second arm
 * exists because `get`, `put`, `delete` and `list` are generic in the type
 * their CALLER names, and rows held in one untyped map cannot restate it.
 */
type StandInFor<Platform> = {
  [Member in keyof Platform]?: Platform[Member] | ((...args: never[]) => object);
};

/**
 * A Durable Object's storage as the platform declares it, with every member
 * this suite did not build refusing by name.
 *
 * `Object.assign` rather than a spread: the result has to BE a
 * `DurableObjectStorage`. Assigning over a refusing base keeps both
 * signatures — the platform's on the type, where every reader validates the
 * rows it asked for, and this suite's at runtime — while a spread would keep
 * only the second and stop being the platform's storage at all.
 */
export function durableObjectStorage(built: StandInFor<DurableObjectStorage>): DurableObjectStorage {
  const refuse = refusing('DurableObjectStorage');
  const kv = refusing('SyncKvStorage');

  return Object.assign({
    get: refuse('get'),
    put: refuse('put'),
    delete: refuse('delete'),
    deleteAll: refuse('deleteAll'),
    list: refuse('list'),
    transaction: refuse('transaction'),
    transactionSync: refuse('transactionSync'),
    getAlarm: refuse('getAlarm'),
    setAlarm: refuse('setAlarm'),
    deleteAlarm: refuse('deleteAlarm'),
    sync: refuse('sync'),
    sql: durableSqlStorage(new Database(':memory:')),
    kv: { get: kv('get'), list: kv('list'), put: kv('put'), delete: kv('delete') },
    getCurrentBookmark: refuse('getCurrentBookmark'),
    getBookmarkForTime: refuse('getBookmarkForTime'),
    onNextSessionRestoreBookmark: refuse('onNextSessionRestoreBookmark'),
  }, built);
}

/**
 * The bag workerd hangs on a Durable Object's `ctx`, reduced to what a
 * workspace host reads off it: the composed supervisor entrypoint the fabric
 * mints every facet's `env.SUPERVISOR` binding from. Not a member of
 * `DurableObjectState` in workers-types, and absent on an object that exports
 * none — which is the state a host refuses to compose over.
 */
export interface ActorObjectState<Exports = unknown> extends DurableObjectState {
  readonly exports?: Exports;
}

/**
 * One Durable Object's `ctx` as the platform gives it, with every member this
 * suite did not build refusing by name. Same assignment rule as
 * {@link durableObjectStorage}, for the same reason.
 */
export function actorObjectState(built: StandInFor<ActorObjectState>): ActorObjectState {
  const refuse = refusing('DurableObjectState');
  const facet = refusing('DurableObjectFacets');

  return Object.assign({
    // Two members a bare object genuinely has none of: no startup props were
    // bound, and no container is attached. Both are `undefined` on the
    // platform too, so neither is a stand-in for something.
    props: undefined,
    container: undefined,
    id: { toString: refuse('id.toString'), equals: refuse('id.equals') },
    storage: durableObjectStorage({}),
    facets: { get: facet('get'), abort: facet('abort'), delete: facet('delete'), clone: facet('clone') },
    waitUntil: refuse('waitUntil'),
    blockConcurrencyWhile: refuse('blockConcurrencyWhile'),
    acceptWebSocket: refuse('acceptWebSocket'),
    getWebSockets: refuse('getWebSockets'),
    setWebSocketAutoResponse: refuse('setWebSocketAutoResponse'),
    getWebSocketAutoResponse: refuse('getWebSocketAutoResponse'),
    getWebSocketAutoResponseTimestamp: refuse('getWebSocketAutoResponseTimestamp'),
    setHibernatableWebSocketEventTimeout: refuse('setHibernatableWebSocketEventTimeout'),
    getHibernatableWebSocketEventTimeout: refuse('getHibernatableWebSocketEventTimeout'),
    getTags: refuse('getTags'),
    abort: refuse('abort'),
  }, built);
}

/** The loader binding the runtime's manager reads at composition. No suite
 *  over this host spawns a facet, so both members refuse by name; `load` is
 *  the member the manager checks for beside `get`, which the fabric's own
 *  declaration omits. */
const noFacetLoader = Object.assign(
  { get: (): never => { throw new Error('no suite over this host spawns a facet'); } },
  { load: (): never => { throw new Error('no suite over this host spawns a facet'); } },
);

/** The fabric composed once per test isolate: first write wins, and every
 *  workspace host in one process states the same composition. */
let fabricComposed = false;

export function programmaticHostOver(workspace: NimbusWorkspace, seams: ProgrammaticHostSeams = {}): TestProgrammaticHost {
  const durable = seams.durable ?? new Map<string, unknown>();

  if (!fabricComposed) {
    // The deployment's own composition, as `createHostedWorkspace` states it.
    composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'OrchestratorAgent', hostDispatchMethod: 'supervisorOp' });
    fabricComposed = true;
  }

  const ctx = actorObjectState({
    id: { toString: () => 'programmatic-host-test', equals: () => false, name: 'programmatic-host-test' },
    storage: durableObjectStorage({ ...durableStorage(durable), sql: durableSqlStorage(new Database(':memory:')) }),
    waitUntil: (promise: Promise<unknown>) => void promise,
    getWebSockets: () => [],
    exports: { SupervisorRPC },
  });

  const portRegistry = new PortRegistry();

  const namespace = {
    get: () => ({ supervisorOp: (envelope: Parameters<NimbusWorkspace['supervisorOp']>[0]) => workspace.supervisorOp(envelope) }),
    idFromName: (name: string) => name,
    idFromString: (id: string) => id,
  };

  // The fabric's host namespace rides beside the runtime's own env members:
  // the runtime reads it by the composed name, off the same object.
  const bindings: Parameters<typeof composeHostedRuntime>[0]['env'] & { readonly OrchestratorAgent: typeof namespace } = {
    OrchestratorAgent: namespace, LOADER: noFacetLoader,
  };

  let composing: Promise<HostedRuntime> | null = null;
  // The scheduler runs without a clock: the launch turn is the one task the
  // runtime asks for NOW and it runs on the next turn; the log flush and
  // janitor are asked for later and stay pending, so a finished suite is never
  // held open by a timer the production host would have armed.
  const pending = new Set<HostedRuntimeTask>();

  const runtime = (): Promise<HostedRuntime> => {
    composing ??= composeHostedRuntime({
      workspace,
      ctx,
      env: bindings,
      ports: portRegistry,
      lifecycle: {
        waitUntil: (task) => { ctx.waitUntil(task); },
        schedule: async (reason) => {
          pending.add(reason);

          if (reason !== 'resident-launch') return;
          queueMicrotask(() => {
            if (!pending.delete(reason)) return;
            ctx.waitUntil(runtime().then((composed) => composed.onScheduled(reason)));
          });
        },
        cancel: async (reason) => { pending.delete(reason); },
      },
    });

    return composing;
  };

  const host: ProgrammaticHost = {
    ready: async (options) => (await runtime()).ready(options),
    exec: async (command, options) => (await runtime()).exec(command, options),
    startProcess: async (command, options) => (await runtime()).startProcess(command, options),
    runCode: async (code, options) => (await runtime()).runCode(code, options),
    listProcesses: async () => (await runtime()).listProcesses(),
    killProcess: async (pid) => (await runtime()).killProcess(pid),
    processLogs: async (pid, options) => (await runtime()).processLogs(pid, options),
    listPorts: async () => (await runtime()).listPorts(),
    exposeApp: async (target, options) => (await runtime()).exposeApp(target, options),
    removeApp: async (target) => (await runtime()).removeApp(target),
    listApps: async () => (await runtime()).listApps(),
    routeCapabilityPort: async (port, capability, request, pathname) => (await runtime()).routeCapabilityPort(port, capability, request, pathname),
    ensureRuntimes: async (specs, options) => (await runtime()).ensureRuntimes(specs, options),
    installRuntime: async (spec, options) => (await runtime()).installRuntime(spec, options),
    listRuntimes: async () => (await runtime()).listRuntimes(),
    spawnWorker: async (code, command, cwd, options) => (await runtime()).spawnWorker(code, command, cwd, options),
    supervisorOp: async (envelope) => (await runtime()).supervisorOp(envelope),
    get files(): never { throw new Error('files are read through the composed runtime: await host.ready() and use runtime().files'); },
    facets: (): never => { throw new Error('the facet manager is read through facetManager(), which awaits the composition'); },
  };

  return {
    host,
    runtime,
    facetManager: async () => (await runtime()).facets(),
    processes: workspace.processes,
    portRegistry,
    durable,
  };
}

export const ensureProgrammaticReady = (host: ProgrammaticHost, options?: Parameters<HostedRuntime['ready']>[0]) => host.ready(options);

export const rpcExec = (host: ProgrammaticHost, ...args: Parameters<HostedRuntime['exec']>) => host.exec(...args);

export const rpcStartProcess = (host: ProgrammaticHost, ...args: Parameters<HostedRuntime['startProcess']>) => host.startProcess(...args);

export const rpcProcessLogs = (host: ProgrammaticHost, ...args: Parameters<HostedRuntime['processLogs']>) => host.processLogs(...args);

export const rpcListPorts = (host: ProgrammaticHost) => host.listPorts();

export const rpcRouteCapabilityPort = (host: ProgrammaticHost, ...args: Parameters<HostedRuntime['routeCapabilityPort']>) => host.routeCapabilityPort(...args);

export type ProgrammaticExecOptions = NonNullable<Parameters<HostedRuntime['exec']>[1]>;

/** What the runtime's `stat` answers, as the credentialed plane reads it. */
const FileStatSchema = v.object({ type: v.string(), size: v.number(), mtime: v.number() });

/**
 * The runtime as the repo reaches it: `exec` carries the credential on every
 * command, and `files.as(agent)` answers the credentialed file plane — the
 * runtime's own files bound to `agent` — which is what the SDK's
 * `files.as(cred)` calls. The top-level `files` verbs refuse, so a
 * credentialed plane can never fall back to the session user. Shared by every
 * suite that boxes a hosted node (node-home-wiring, facet-tmp-confinement):
 * two copies of this shape already drifted once.
 */
export function credentialedSessionBox(
  runtime: () => Promise<HostedRuntime>,
  cred: VfsCred,
): NimbusSandboxHandle {
  const refuse = async (): Promise<never> => { throw new Error('a credentialed plane must not fall back to the session user'); };

  const filesAs = (agent: VfsCred): NimbusSandboxHandle['files'] => {
    const view = async () => (await runtime()).files.as(agent);

    return {
      as: filesAs,
      read: async (path) => await (await view()).exists(path) ? (await view()).readFile(path) : null,
      readBytes: async (path) => await (await view()).exists(path) ? (await view()).readFile(path, null) : null,
      readRange: async (path, offset, length) => {
        const vfs = (await runtime()).workspace.vfs.as(agent);

        return vfs.exists(path) ? vfs.readRange(path, offset, length) : null;
      },
      write: async (path, content) => { await (await view()).writeFile(path, content); },
      list: async (path) => (await (await view()).readdir(path ?? '/')).map((entry) => ({ name: entry.name, type: entry.type })),
      stat: async (path) => {
        const files = await view();

        if (!await files.exists(path)) return null;
        const stat = await files.stat(path);

        return v.parse(FileStatSchema, { type: stat.type, size: stat.size, mtime: stat.mtime });
      },
      rename: async (from, to) => { await (await view()).rename(from, to); },
      exists: async (path) => (await view()).exists(path),
      mkdir: async (path) => { await (await view()).mkdir(path, { recursive: true }); },
      delete: async (path, options) => { await (await view()).rm(path, { recursive: options?.recursive ?? false }); },
    };
  };

  return {
    ready: async () => { await (await runtime()).ready(); },
    exec: async (rawCommand, options) => {
      // Assigned rather than spread conditionally: an absent environment must
      // stay an ABSENT KEY, because the runner reads presence to decide whether
      // it was handed a request at all.
      const forwarded: ProgrammaticExecOptions = { cred: options?.cred ?? cred };

      if (options?.cwd !== undefined) forwarded.cwd = options.cwd;

      if (options?.env !== undefined) forwarded.env = options.env;
      const result = await (await runtime()).exec(rawCommand, forwarded);

      return {
        command: rawCommand,
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    files: { as: filesAs, read: refuse, write: refuse, list: refuse, exists: refuse, delete: refuse },
  };
}
