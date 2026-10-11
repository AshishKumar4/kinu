/**
 * The hosted workspace, in the Durable Object that owns it: Nimbus over `ctx.storage.sql`, so a file write
 * and the FTS5 rows indexing it commit under one `transactionSync`. Composes core's `createWorkspace` with
 * Nimbus's hosted runtime (`composeHostedRuntime`); facets reach it through {@link createWorkspaceBoxClient}.
 */

import { createWorkspace, storeFiles, workspaceGenerationStorage } from '@kinu.run/core/workspace';
import type { RuntimeSource, SupervisorOpResult, WorkspaceBundle, WorkspaceFiles, WorkspaceOptions } from '@kinu.run/core/workspace';
import { jsonResultOrVoid, sha256Hex } from '@kinu.run/core';
import type {
  NimbusExecResult, NimbusPortInfo, NimbusSandboxHandle, NimbusStartResult, PreviewRouteCheck, WorkspacePreviewUrl,
} from '@kinu.run/core';
import { diagnostics, KinuError, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import type { ObjectNamespace, ServingScope } from '@kinu.run/core';
import type { ComposedFacetManager, HostedRuntime, HostedRuntimeOptions, HostedRuntimeTask, HostedSession, HostedSessionScope, WorkerRecipe } from '@nimbus-sh/worker/workspace-host';
import { clearPortCapability, listPortReservations, readPortReservation, readPortReservationByOwner, releasePortReservation } from '@nimbus-sh/worker/port-capability';
import type { DurableApps } from '@kinu.run/core/slates';
import * as v from 'valibot';
import type { NimbusTasks } from './nimbus-tasks';

const HOST_FABRIC_COMPOSITION: FabricComposition = {
  supervisorEntrypoint: 'SupervisorRPC',
  hostNamespace: 'OrchestratorAgent',
  hostDispatchMethod: 'supervisorOp',
};

/** Crosses as itself: workerd refuses a wrapped stub as an outbound. */
type FabricWorkerLoader = NonNullable<HostedRuntimeOptions['env']['LOADER']>;

const FabricWorkerLoaderSchema = v.custom<FabricWorkerLoader>(
  (value) => v.is(v.object({ get: v.function() }), value),
  'the LOADER binding must be a worker loader',
);

function fabricLoader(loader: WorkerLoader): FabricWorkerLoader {
  return v.parse(FabricWorkerLoaderSchema, loader);
}

/** Also answered by the siblings Nimbus opens under other names. */
export interface WorkspaceHostTarget {
  supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult>;
}

/** The supervisor entrypoint resolves its host from an id, never a name. */
interface WorkspaceHostNamespace<Id> extends ObjectNamespace<Id, WorkspaceHostTarget> {
  idFromString(id: string): Id;
}

/** Never the whole Env: that would put every binding inside a package manager. */
export interface HostedWorkspaceEnv<Id> extends Pick<Env, 'LOADER' | 'NIMBUS_RUNTIME_CACHE' | 'NIMBUS_RUNTIME_CATALOG_SHA256'> {
  readonly ASSETS?: Fetcher;
  readonly OrchestratorAgent: WorkspaceHostNamespace<Id>;
}

type HostedRuntimeBindings<Id> = HostedRuntimeOptions['env'] & { readonly OrchestratorAgent: WorkspaceHostNamespace<Id> };

/** Loaded on first composition, not at module eval, to keep cold start and the test pool loader clean. */
interface HostedRuntimeModule {
  readonly composeHostedRuntime: (options: HostedRuntimeOptions) => Promise<HostedRuntime>;
  readonly runtimeCatalogSource: (env: Pick<HostedRuntimeOptions['env'], 'NIMBUS_RUNTIME_CACHE' | 'NIMBUS_RUNTIME_CATALOG_SHA256'>) => RuntimeSource;
}

let runtimeModule: Promise<HostedRuntimeModule> | null = null;

function hostedRuntimeModule(): Promise<HostedRuntimeModule> {
  runtimeModule ??= import('@nimbus-sh/worker/workspace-host').then((module) => ({
    composeHostedRuntime: module.composeHostedRuntime,
    runtimeCatalogSource: module.runtimeCatalogSource,
  }));

  return runtimeModule;
}

export interface HostedWorkspaceDeps<Id> {
  readonly ctx: DurableObjectState;
  readonly env: HostedWorkspaceEnv<Id>;
  /** The actor's Lifecycle jobs for Nimbus's tasks; each runs through `onScheduled`. */
  readonly tasks: Pick<NimbusTasks, 'schedule' | 'cancel'>;
  /** Supplied by the actor: the URL names the workspace and is signed with a user-plane-derived key. */
  previewUrl: (port: number, capability: string) => Promise<WorkspacePreviewUrl>;
  onFilesChanged?: (paths: readonly string[]) => void;
  onPortsChanged?: () => void;
  /** Kinu's egress for the workspace's commands and programs, asked once as the workspace opens. */
  readonly egress?: WorkspaceOptions['egress'];
  /** Asked before a preview request is routed and by the launch journal after a reset. A refusal says why
     *  the slate cannot serve. */
  ensureSlate?(owner: string): Promise<Refusal | null>;
  /** Keeps a slate from replaying a retained stub as an unnamed root lineage. `socket`: the invocation
     *  must outlive the routed 101 response. */
  slateInvocation?(port: number, socket: boolean): { readonly value: string; release: () => void } | null;
  pictures?: {
    captures(port: number, handle: string): boolean;
    rendered(slate: string, port: number): void;
  };
}

interface HostComposition {
  readonly runtime: HostedRuntime;
  readonly facets: ComposedFacetManager;
  readonly ports: PortRegistry;
}

/** The runtime compares the socket by identity and only calls `send`. */
export interface TerminalSocket {
  send(data: string): void;
}

export interface WorkspaceTerminal {
  attachTerminal(ws: TerminalSocket): Promise<void>;
  terminalFrame(ws: TerminalSocket, frame: string | ArrayBuffer): Promise<void>;
  terminalClose(ws: TerminalSocket): void;
}

export interface WorkspaceServing {
  readonly held: readonly { readonly port: number; readonly stamp: string | null }[];
  readonly jobs: ReadonlySet<string>;
}

/**
 * The recorded serving facts a read of the workspace alone answers for: those of the jobs it runs a process for, by the
 * job's id. Not by port: a box this activation did not read may serve the same port number for one of its own jobs.
 */
export function workspaceServingScope(serving: WorkspaceServing): ServingScope {
  return (fact) => serving.jobs.has(fact.job);
}

/** A box over the workspace this object hosts: its store is the database itself, so its files need no session call. */
export interface HostedBox extends NimbusSandboxHandle {
  /** The store as `cred` (default the session user) sees it, relative paths from `home` (`storeFiles`). */
  store(plane: Parameters<typeof storeFiles>[1]): WorkspaceFiles;
}

export interface HostedWorkspace {
  readonly bundle: WorkspaceBundle;
  /** One agent's view: a named call runs in the runtime's named shell, keyed by `scope` and the name. */
  box(scope: string): HostedBox;
  /**
   * Each exposed workspace port with the job whose process listens on it, by the exec id that process carries, and every
   * job with a live process here.
   */
  serving(): Promise<WorkspaceServing>;
  /** Answered by the hosted runtime (host ops need it), for every name this object is opened under; a
     *  sibling is never a Kinu workspace, so nothing here claims an owner or writes a transcript. The envelope
     *  is a hosted process's own data: Nimbus's dispatcher is the one place that refuses an op it does not serve. */
  supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult>;
  /** The SDK session one agent's own isolate drives. */
  session(scope: HostedSessionScope): Promise<HostedSession>;
  /** The slate host's spawn/kill path and the one registrar of a resident's port. */
  facetManager(): Promise<ComposedFacetManager>;
  ports(): Promise<PortRegistry>;
  /** One terminal per workspace; a second attach replaces the first. */
  terminal(): Promise<WorkspaceTerminal>;
  readonly apps: DurableApps;
  /** The edge has verified the signed hostname; the full capability never leaves this object. */
  routePreview(port: number, handle: string, request: Request, pathname: string): Promise<Response>;
  /** Runs one of Nimbus's scheduled tasks, composing the runtime on a cold wake. */
  onScheduled(task: HostedRuntimeTask): Promise<void>;
  /** Leaves the actor's rows alone. */
  destroy(): Promise<void>;
}

/** Pins a URL to one exposure; the full 24-hex capability would not fit the DNS label. */
export const PREVIEW_CAPABILITY_HANDLE_LENGTH = 10;

function isRender(request: Request, response: Response): boolean {
  const destination = request.headers.get('sec-fetch-dest');

  return request.method === 'GET' && (destination === 'document' || destination === 'iframe')
    && response.status === 200 && (response.headers.get('content-type') ?? '').startsWith('text/html');
}

/** Never a 403: a wrong handle must not confirm that the port is listening. */
function previewNotFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

function previewUnavailable(refusal: Refusal): Response {
  return new Response(JSON.stringify({ reason: refusal.reason, error: refusal.error }), {
    status: 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json', 'retry-after': '3' },
  });
}

interface PreviewGateRefusal {
  readonly gate: 'no-exposure' | 'handle-mismatch' | 'ensure-missing' | 'ensure-unavailable' | 'no-listener' | 'capability-mismatch';
  readonly owner: string | null;
  readonly detail: string;
  readonly refusal?: Refusal;
}

type PreviewGates =
  | { readonly routed: false; readonly refused: PreviewGateRefusal }
  | {
    readonly routed: true; readonly capability: string; readonly refused: PreviewGateRefusal | null;
    readonly slate: string | null; readonly capture: boolean;
  };

function routeCheck(gates: PreviewGates): PreviewRouteCheck {
  return gates.refused === null
    ? { reached: true }
    : { reached: false, gate: gates.refused.gate, detail: gates.refused.detail };
}

/** Rows carry the recipe, never the inputs: the slate host re-drives through its own boot and the row is
 * released by answering null. An interpreter resident is never an embedder's launch. */
/** A throw inside `waitUntil` would otherwise vanish. */
async function redriveSlate(ensuring: Promise<Refusal | null>, owner: string): Promise<void> {
  try {
    const refusal = await ensuring;

    if (refusal !== null) {
      diagnostics.event('workspace.facet.redrive_refused', { owner, reason: refusal.reason, error: refusal.error });
    }
  } catch (cause) {
    diagnostics.failure('workspace.facet.redrive_failed', toKinuError({
      doing: 're-driving a slate launch a hibernation interrupted', cause, otherwise: 'io',
    }), { owner });
  }
}

function resolveSlateLaunch<Id>(deps: HostedWorkspaceDeps<Id>, recipe: WorkerRecipe): Promise<null> {
  if (recipe.resident !== undefined || deps.ensureSlate === undefined) return Promise.resolve(null);

  deps.ctx.waitUntil(redriveSlate(deps.ensureSlate(recipe.owner), recipe.owner));

  return Promise.resolve(null);
}

/** Called once per isolate; the filesystem opens on first operation. */
export function createHostedWorkspace<Id>(deps: HostedWorkspaceDeps<Id>): HostedWorkspace {
  const sql = deps.ctx.storage.sql;
  const catalog = deps.env.NIMBUS_RUNTIME_CACHE;
  const catalogDigest = { NIMBUS_RUNTIME_CACHE: catalog, NIMBUS_RUNTIME_CATALOG_SHA256: deps.env.NIMBUS_RUNTIME_CATALOG_SHA256 };

  // Only the R2 catalogue of this env, read by the digest it names; the module is read lazily.
  const runtimeSource: RuntimeSource | undefined = catalog === undefined ? undefined : {
    list: async () => (await hostedRuntimeModule()).runtimeCatalogSource(catalogDigest).list(),
    resolve: async (spec) => (await hostedRuntimeModule()).runtimeCatalogSource(catalogDigest).resolve(spec),
  };

  const bundle = createWorkspace({
    sql,
    transactions: deps.ctx,
    generation: workspaceGenerationStorage(sql),
    // The fabric mints each facet's `env.SUPERVISOR`, and `ctx.exports` comes off `transactions` (the DO's
    // own `ctx`). Without both, `git clone` refuses.
    fabric: HOST_FABRIC_COMPOSITION,
    runtimeSource,
    ...(deps.egress !== undefined && { egress: deps.egress }),
  });

  if (deps.onFilesChanged) bundle.onFilesChanged(deps.onFilesChanged);

  // One registry per isolate: a port is a live listener in this isolate's memory.
  const portRegistry = deps.onPortsChanged ? new ObservedPortRegistry(deps.onPortsChanged) : new PortRegistry();
  let composing: Promise<HostComposition> | undefined;

  const lifecycle: HostedRuntimeOptions['lifecycle'] = {
    waitUntil: (task) => { deps.ctx.waitUntil(task); },
    schedule: (task, at) => deps.tasks.schedule(task, at),
    cancel: (task) => deps.tasks.cancel(task),
  };

  const compose = async (): Promise<HostComposition> => {
    composing ??= (async (): Promise<HostComposition> => {
      try {
        const session = await bundle.session();
        const { composeHostedRuntime } = await hostedRuntimeModule();

        const runtimeBindings: HostedRuntimeBindings<Id> = {
          OrchestratorAgent: deps.env.OrchestratorAgent,
          LOADER: fabricLoader(deps.env.LOADER),
          ASSETS: deps.env.ASSETS,
          ...catalogDigest,
        };

        const runtime = await composeHostedRuntime({
          workspace: session.workspace,
          ctx: deps.ctx,
          env: runtimeBindings,
          ports: portRegistry,
          lifecycle,
          resolveWorkerLaunch: (recipe) => resolveSlateLaunch(deps, recipe),
        });

        // Cold-start recovery of the launch journal, as Nimbus's own session pumps once at init.
        deps.ctx.waitUntil(runtime.onScheduled('resident-launch'));

        return { runtime, facets: runtime.facets(), ports: portRegistry };
      } catch (cause) {
        // A cached rejection would poison every later op on one transient failure.
        composing = undefined;
        throw cause;
      }
    })();

    return await composing;
  };

  const runtime = async (): Promise<HostedRuntime> => (await compose()).runtime;

  // Checked against the durable record: a port never handed a URL is refused even if something listens.
  const previewGates = async (port: number, handle: string): Promise<PreviewGates> => {
    const exposure = await readPortReservation(deps.ctx, port);
    const capability = exposure?.capability ?? null;

    if (exposure === null || capability === null) {
      return { routed: false, refused: { gate: 'no-exposure', owner: null, detail: `no exposure record holds port ${port}` } };
    }

    const { owner } = exposure;
    const slate = owner !== null && exposure.kind === 'explicit' ? owner : null;
    const matches = capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH) === handle;
    const capture = !matches && slate !== null && deps.pictures?.captures(port, handle) === true;

    if (!matches && !capture) {
      return { routed: false, refused: { gate: 'handle-mismatch', owner, detail: `the URL names another exposure of port ${port}` } };
    }

    const refusal = owner !== null && exposure.kind === 'explicit' ? await deps.ensureSlate?.(owner) ?? null : null;

    if (refusal !== null) {
      const gate = refusal.reason === 'missing' ? 'ensure-missing' : 'ensure-unavailable';

      return { routed: false, refused: { gate, owner, detail: refusal.error, refusal } };
    }

    const listener = portRegistry.get(port);

    if (listener === undefined) {
      return { routed: true, capability, slate, capture, refused: { gate: 'no-listener', owner, detail: `nothing is listening on port ${port}` } };
    }

    if (listener.capability !== capability) {
      const state = (await bundle.session()).processes.get(listener.pid)?.state ?? 'absent';

      return {
        routed: true, capability, slate, capture,
        refused: { gate: 'capability-mismatch', owner, detail: `pid=${String(listener.pid)} state=${state}` },
      };
    }

    return { routed: true, capability, slate, capture, refused: null };
  };

  return {
    bundle,
    supervisorOp: async (envelope) => (await runtime()).supervisorOp(envelope),
    session: async (scope) => (await runtime()).session(scope),
    box: (scope) => ({
      ...workspaceBox({
        runtime, ports: portRegistry, ctx: deps.ctx, scope, previewUrl: deps.previewUrl, previewGates, exposed: deps.onPortsChanged,
        mountTable: (mounts, principal) => bundle.mountTable(mounts, principal),
        namespace: (principal) => bundle.namespace(principal),
      }),
      store: (plane) => storeFiles(async () => (await bundle.session()).vfs, plane),
    }),
    // A listing says which job serves a port; it is no authority over the port's exposure. A runtime this isolate never
    // composed runs no process, so it answers nothing without booting the workspace.
    serving: async () => {
      if (composing === undefined) return { held: [], jobs: new Set() };
      await composing;
      const { processes } = await bundle.session();
      const exposed = [...await listPortReservations(deps.ctx)].flatMap(([port, held]) => (held.capability === null ? [] : [port]));

      return {
        held: exposed.map((port) => {
          const listener = portRegistry.get(port);

          return { port, stamp: listener === undefined ? null : processes.get(listener.pid)?.execId ?? null };
        }),
        jobs: new Set(processes.getRunning().flatMap((entry) => (entry.execId === undefined ? [] : [entry.execId]))),
      };
    },
    facetManager: async () => (await compose()).facets,
    ports: async () => (await compose()).ports,
    terminal: async () => {
      const { attachTerminal, terminalFrame, terminalClose } = await runtime();

      return { attachTerminal, terminalFrame, terminalClose };
    },
    apps: {
      async ensure({ owner, preferredPort }) {
        const { facets } = await compose();
        const held = await readPortReservationByOwner(deps.ctx, owner);

        // The declaration moved: release the old reservation; the facet slot (and its storage) is kept.
        if (held !== null && preferredPort !== undefined && held.port !== preferredPort) {
          await releasePortReservation(deps.ctx, { owner, port: held.port });
        }

        const reserved = await facets.apps.ensureDurableApp({ owner, preferredPort, visibility: 'scoped' });

        if (reserved.capability === null) {
          throw new KinuError('io', `Nimbus reserved workspace port ${reserved.port} for ${owner} without a capability`);
        }

        return { port: reserved.port, capability: reserved.capability };
      },
      async remove(owner) {
        const removed = await (await runtime()).removeApp({ owner });

        return { removed: removed.removed, port: removed.port };
      },
    },
    async routePreview(port, handle, request, pathname) {
      const gates = await previewGates(port, handle);

      // Every refusal names its branch: a bare 404 is otherwise indistinguishable from the runner's own.
      if (gates.refused !== null) {
        const { gate, owner, detail } = gates.refused;
        diagnostics.event('preview.route.refused', { port, handle, reason: gate, owner: owner ?? '', detail });
      }

      if (!gates.routed) {
        const { refusal } = gates.refused;

        return refusal === undefined || refusal.reason === 'missing' ? previewNotFound() : previewUnavailable(refusal);
      }

      const { capability } = gates;

      const publicRequest = new Request(request);
      // Drop the visitor's header first: naming the invocation stops retained preview bindings standing in
      // for a deeper lineage.
      publicRequest.headers.delete('x-slate-call');
      const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      const invocation = deps.slateInvocation?.(port, upgrade) ?? null;

      if (invocation !== null) publicRequest.headers.set('x-slate-call', invocation.value);
      // The runtime's own route: it readies the runtime first, and a visitor's request is a client's to it.
      const routed = await runtime();

      try {
        const response = await routed.routeCapabilityPort(port, capability, publicRequest, pathname);

        // A 101 only opens the socket: the process's close listener releases the invocation.
        if (response.status !== 101) invocation?.release();

        if (gates.slate !== null && !gates.capture && isRender(request, response)) deps.pictures?.rendered(gates.slate, port);

        return response;
      } catch (cause) {
        invocation?.release();
        throw cause;
      }
    },
    onScheduled: async (task) => { await (await runtime()).onScheduled(task); },
    destroy: () => bundle.destroy(),
  };
}

/** Nimbus mutates listeners only through these three. */
class ObservedPortRegistry extends PortRegistry {
  constructor(private readonly moved: () => void) {
    super();
  }

  override register(port: number, pid: number): void {
    super.register(port, pid);
    this.moved();
  }

  override unregister(port: number): boolean {
    const removed = super.unregister(port);

    if (removed) this.moved();

    return removed;
  }

  override unregisterByPid(pid: number): number {
    const removed = super.unregisterByPid(pid);

    if (removed > 0) this.moved();

    return removed;
  }
}

const NamedShellStateSchema = v.object({ cwd: v.pipe(v.string(), v.startsWith('/')) });

/** Where Nimbus keeps a named shell's state, in the workspace's own SQLite (core `SHELLS_TABLE`); it has no public read. */
const NIMBUS_SHELLS_TABLE = 'vfs_shells';

function namedShellCwd(sql: SqlStorage, id: string): string | null {
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", NIMBUS_SHELLS_TABLE).toArray().length === 0) return null;
  const [row] = sql.exec(`SELECT cwd FROM ${NIMBUS_SHELLS_TABLE} WHERE id = ?`, id).toArray();
  const saved = v.safeParse(NamedShellStateSchema, row);

  return saved.success ? saved.output.cwd : null;
}

function workspaceBox(deps: {
  runtime: () => Promise<HostedRuntime>;
  ports: PortRegistry;
  ctx: DurableObjectState;
  scope: string;
  previewUrl(port: number, capability: string): Promise<WorkspacePreviewUrl>;
  previewGates(port: number, handle: string): Promise<PreviewGates>;
  /** An exposure changed which ports are exposed; a withdrawal is the registry's own move. */
  exposed: (() => void) | undefined;
  mountTable: NonNullable<NimbusSandboxHandle['mountTable']>;
  namespace: NonNullable<NimbusSandboxHandle['namespace']>;
}): NimbusSandboxHandle {
  const { runtime, scope } = deps;
  const shellId = (name: string): string => `agent:${sha256Hex(`${scope}\u0000${name}`)}`;

  const named = <O extends { readonly name?: string }>(options: O | undefined) => {
    if (options?.name === undefined) return options;
    const { name, ...rest } = options;

    return { ...rest, shellId: shellId(name) };
  };

  return {
    ready: async () => { await (await runtime()).ready(); },
    exec: async (command, options): Promise<NimbusExecResult> => await (await runtime()).exec(command, named(options)),
    execStream: async (command, options) => await (await runtime()).execStream(command, named(options)),
    startProcess: async (command, options): Promise<NimbusStartResult> => await (await runtime()).startProcess(command, named(options)),
    runCode: async (code, options): Promise<NimbusExecResult> => await (await runtime()).runCode(code, named(options)),
    shellCwd: async (name) => namedShellCwd(deps.ctx.storage.sql, shellId(name)),
    runtimes: {
      ensure: async (specs, options) => await jsonResultOrVoid((await runtime()).ensureRuntimes(Array.isArray(specs) ? [...specs] : [specs], options)),
      install: async (spec, options) => await jsonResultOrVoid((await runtime()).installRuntime(spec, options)),
      list: async () => await jsonResultOrVoid((await runtime()).listRuntimes()),
    },
    processes: {
      list: async () => await jsonResultOrVoid((await runtime()).listProcesses()),
      kill: async (pid) => await jsonResultOrVoid((await runtime()).killProcess(pid)),
      logs: async (pid, options) => await jsonResultOrVoid((await runtime()).processLogs(pid, options)),
    },
    ports: {
      expose: async (port) => {
        const exposed = await (await runtime()).exposeApp({ port });

        if (exposed.capability === null) throw new Error(`No process is listening on workspace port ${port}`);
        const answer = await deps.previewUrl(port, exposed.capability);

        if (answer.url === undefined) {
          throw new KinuError('unsupported', `workspace port ${port} is listening and has no preview URL: ${answer.unavailable}`);
        }

        const gates = await deps.previewGates(port, exposed.capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH));

        deps.exposed?.();

        return { port: exposed.port, pid: exposed.pid, capability: exposed.capability, url: answer.url, route: routeCheck(gates) };
      },
      // Retire the capability before dropping the listener, so a crash leaves a dead token, not a live one.
      unexpose: async (port) => {
        await runtime();
        await clearPortCapability({ ctx: deps.ctx, portRegistry: deps.ports }, port);

        return { port, ok: deps.ports.unregister(port) };
      },
      list: async () => await Promise.all(
        (await (await runtime()).listPorts()).map(
          async (entry): Promise<NimbusPortInfo & WorkspacePreviewUrl> => ({
            ...entry, ...await deps.previewUrl(entry.port, entry.capability),
          }),
        ),
      ),
    },
    mountTable: deps.mountTable,
    namespace: deps.namespace,
  };
}

