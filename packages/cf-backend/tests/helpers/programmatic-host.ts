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
import type { SqlDatabase, SqlRow, SqlValue } from '@nimbus-sh/core/runtime/os-contracts.js';
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
  const list = async <T,>(options: { prefix: string }): Promise<Map<string, T>> => {
    const entries = new Map<string, unknown>();

    for (const [key, value] of durable) {
      if (key.startsWith(options.prefix)) entries.set(key, value);
    }

    // SAFETY: the storage list contract types each row by the caller's T,
    // which the untyped stand-in rows cannot name; `never` keeps the Map
    // assignable to every T.
    return entries as Map<string, never>;
  };

  const transactionView: DurableTransaction = {
    get: async (key) => durable.get(key),
    put: async (key, value) => { durable.set(key, value); },
    delete: async (key) => durable.delete(key),
    list,
  };

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

/** The object's own SQLite, where the runtime persists process logs and shell
 *  state: a fresh in-memory database per host, as a fresh object's would be. */
function durableSql(): SqlDatabase {
  const database = new Database(':memory:');

  return {
    exec(query: string, ...bindings: SqlValue[]) {
      const statement = database.prepare<SqlRow, SQLQueryBindings[]>(query);
      const bound = bindings.map(sqlBinding);

      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bound);
      statement.run(...bound);

      return [];
    },
  };
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

  const context = {
    id: { toString: () => 'programmatic-host-test', name: 'programmatic-host-test' },
    storage: { ...durableStorage(durable), sql: durableSql() },
    waitUntil: (promise: Promise<unknown>) => void promise,
    getWebSockets: () => [],
    exports: { SupervisorRPC },
  };

  // Unchecked and named: `DurableObjectState` is a workerd type with no
  // constructible form; the runtime reads `id`, `storage`, `waitUntil`,
  // `getWebSockets` and `exports` — all present above — while `facets` is
  // only touched by a spawn no suite over this host performs.
  const ctx: DurableObjectState = Object.create(context);

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
  const timers = new Map<HostedRuntimeTask, ReturnType<typeof setTimeout>>();

  const runtime = (): Promise<HostedRuntime> => {
    composing ??= composeHostedRuntime({
      workspace,
      ctx,
      env: bindings,
      ports: portRegistry,
      lifecycle: {
        waitUntil: (task) => { ctx.waitUntil(task); },
        // The production host's timer per reason, unreferenced so a janitor
        // the runtime re-arms every minute never holds a finished suite open.
        schedule: async (reason, at) => {
          const held = timers.get(reason);

          if (held !== undefined) clearTimeout(held);

          const timer = setTimeout(() => {
            timers.delete(reason);
            ctx.waitUntil(runtime().then((composed) => composed.onScheduled(reason)));
          }, Math.max(0, at - Date.now()));

          timer.unref();
          timers.set(reason, timer);
        },
        cancel: async (reason) => {
          const held = timers.get(reason);

          if (held !== undefined) clearTimeout(held);
          timers.delete(reason);
        },
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
