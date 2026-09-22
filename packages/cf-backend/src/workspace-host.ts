/**
 * The hosted workspace, in the Durable Object that owns it: Nimbus over `ctx.storage.sql`, so a file write
 * and the FTS5 rows indexing it commit under one `transactionSync`. Composes core's `createWorkspace` with
 * Nimbus's hosted runtime (`composeHostedRuntime`); facets reach it through {@link createWorkspaceBoxClient}.
 */

import { createWorkspace, workspaceGenerationStorage } from '@kinu.run/core/workspace';
import type { RuntimeSource, SupervisorOpResult, WorkspaceBundle } from '@kinu.run/core/workspace';
import { decodeJsonValue } from '@kinu.run/core';
import type {
  JsonValue,
  NimbusExecResult, NimbusPortInfo, NimbusSandboxHandle, NimbusStartResult, WorkspacePreviewUrl,
} from '@kinu.run/core';
import { diagnostics, KinuError, tolerate, toKinuError, type Refusal } from '@kinu.run/core/obs';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import { SUPERVISOR_OPS, type SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import type { ObjectNamespace } from '@kinu.run/core';
import type { ComposedFacetManager, HostedRuntime, HostedRuntimeOptions, HostedRuntimeTask, WorkerRecipe } from '@nimbus-sh/worker/workspace-host';
import { clearPortCapability, readPortExposure, readPortReservationByOwner, releasePortReservation } from '@nimbus-sh/worker/port-capability';
import type { DurableApps } from '@kinu.run/core/slates';
import * as v from 'valibot';

/** `NIMBUS_SESSION` is deliberately not named: the class is gone (wrangler.jsonc migration `v3`). */
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
export interface WorkspaceHostNamespace<Id> extends ObjectNamespace<Id, WorkspaceHostTarget> {
  idFromString(id: string): Id;
}

/** Never the whole Env: that would put every binding inside a package manager. */
export interface HostedWorkspaceEnv<Id> extends Pick<Env, 'LOADER' | 'NIMBUS_RUNTIME_CACHE'> {
  readonly ASSETS?: Fetcher;
  readonly OrchestratorAgent: WorkspaceHostNamespace<Id>;
}

type HostedRuntimeBindings<Id> = HostedRuntimeOptions['env'] & { readonly OrchestratorAgent: WorkspaceHostNamespace<Id> };

/** Loaded on first composition, not at module eval, to keep cold start and the test pool loader clean. */
interface HostedRuntimeModule {
  readonly composeHostedRuntime: (options: HostedRuntimeOptions) => Promise<HostedRuntime>;
  readonly runtimeCatalogSource: (env: Pick<HostedRuntimeOptions['env'], 'NIMBUS_RUNTIME_CACHE'>) => RuntimeSource;
}

let runtimeModule: Promise<HostedRuntimeModule> | null = null;

function hostedRuntimeModule(): Promise<HostedRuntimeModule> {
  runtimeModule ??= import('@nimbus-sh/worker/workspace-host').then((module) => ({
    composeHostedRuntime: module.composeHostedRuntime,
    runtimeCatalogSource: module.runtimeCatalogSource,
  }));

  return runtimeModule;
}

/** Only ENOENT (by `code`, not rendered text) reads as absence; other failures throw. */
function absentAsNull<T>(read: () => T): T | null {
  return tolerate(read, 'enoent') ?? null;
}

/** The raw `SqliteVFS` as the session user: the same identity the Nimbus session's file RPCs resolve to. */
function workspaceBoxFiles(open: () => Promise<SqliteVFS>, cred: VfsCred = CRED_SESSION_USER): NimbusSandboxHandle['files'] {
  const view = async (): Promise<CredentialedVfs> => (await open()).as(cred);

  return {
    as: (agent) => workspaceBoxFiles(open, agent),
    async read(path) {
      const vfs = await view();

      return absentAsNull(() => vfs.readFileString(path));
    },
    async readBytes(path) {
      const vfs = await view();

      return absentAsNull(() => vfs.readFile(path));
    },
    async readRange(path, offset, length) {
      const vfs = await view();

      return absentAsNull(() => vfs.readRange(path, offset, length));
    },
    async write(path, content) {
      const vfs = await view();
      // The SDK write contract creates missing parents.
      const cut = path.lastIndexOf('/');

      if (cut > 0) {
        const parent = path.slice(0, cut);

        if (!vfs.exists(parent)) vfs.mkdir(parent, { recursive: true });
      }

      vfs.writeFile(path, content);
    },
    async stat(path) {
      const vfs = await view();

      return absentAsNull(() => {
        const stat = vfs.stat(path);

        return { type: stat.type, size: stat.size, mtime: stat.mtime };
      });
    },
    async lstat(path) {
      const vfs = await view();

      return absentAsNull(() => {
        const stat = vfs.lstat(path);

        return { type: stat.type, size: stat.size, mtime: stat.mtime, mode: stat.mode };
      });
    },
    async rename(from, to) { (await view()).rename(from, to); },
    async chmod(path, mode) { (await view()).chmod(path, mode); },
    async list(path) {
      return (await view()).readdir(path ?? '/').map((entry) => ({ name: entry.name, type: entry.type }));
    },
    async exists(path) { return (await view()).exists(path); },
    async mkdir(path) { (await view()).mkdir(path, { recursive: true }); },
    async delete(path, options) {
      const vfs = await view();

      if (options?.recursive) {
        vfs.removeRecursive(path);

        return;
      }

      // Non-recursive delete of a directory is `rmdir`, which refuses a populated one.
      if (vfs.isDirectory(path)) {
        vfs.rmdir(path);

        return;
      }

      vfs.unlink(path);
    },
  };
}

export interface HostedWorkspaceDeps<Id> {
  readonly ctx: DurableObjectState;
  readonly env: HostedWorkspaceEnv<Id>;
  /** Supplied by the actor: the URL names the workspace and is signed with a user-plane-derived key. */
  previewUrl: (port: number, capability: string) => Promise<WorkspacePreviewUrl>;
  onFilesChanged?: (paths: readonly string[]) => void;
  /** Asked before a preview request is routed and by the launch journal after a reset. A refusal says why
     *  the slate cannot serve. */
  ensureSlate?(owner: string): Promise<Refusal | null>;
  /** Keeps a slate from replaying retained bindings as an unnamed root lineage. `socket`: the invocation
     *  must outlive the routed 101 response. */
  slateInvocation?(port: number, socket: boolean): { readonly value: string; release: () => void } | null;
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

/** `op` arrives as wire data: any string a process in this workspace put on it. */
export interface WireSupervisorEnvelope extends Omit<SupervisorOpEnvelope, 'op'> {
  readonly op: string;
}

const SERVED_OPS: ReadonlySet<string> = new Set(SUPERVISOR_OPS);

/** A runtime refusal: every `SupervisorOpName` is served, so only an off-the-wire name reaches it. */
function servesOp(envelope: WireSupervisorEnvelope): envelope is SupervisorOpEnvelope {
  return SERVED_OPS.has(envelope.op);
}

export interface HostedWorkspace {
  readonly bundle: WorkspaceBundle;
  /** Cached by `shellId`: a named shell holds its own cwd and exported variables. */
  box(shellId: string): NimbusSandboxHandle;
  /** Answered by the hosted runtime (host ops need it), for every name this object is opened under; a
     *  sibling is never a Kinu workspace, so nothing here claims an owner or writes a transcript. */
  supervisorOp(envelope: WireSupervisorEnvelope): Promise<SupervisorOpResult>;
  /** The slate host's spawn/kill path and the one registrar of a resident's port. */
  facetManager(): Promise<ComposedFacetManager>;
  ports(): Promise<PortRegistry>;
  /** One terminal per workspace; a second attach replaces the first. */
  terminal(): Promise<WorkspaceTerminal>;
  readonly apps: DurableApps;
  /** The edge has verified the signed hostname; the full capability never leaves this object. */
  routePreview(port: number, handle: string, request: Request, pathname: string): Promise<Response>;
  /** Leaves the actor's rows alone. */
  destroy(): Promise<void>;
}

/** Pins a URL to one exposure; the full 24-hex capability would not fit the DNS label. */
export const PREVIEW_CAPABILITY_HANDLE_LENGTH = 10;

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

  // Only the R2 catalogue of this env; the module is read lazily.
  const runtimeSource: RuntimeSource | undefined = catalog === undefined ? undefined : {
    list: async () => (await hostedRuntimeModule()).runtimeCatalogSource({ NIMBUS_RUNTIME_CACHE: catalog }).list(),
    resolve: async (spec) => (await hostedRuntimeModule()).runtimeCatalogSource({ NIMBUS_RUNTIME_CACHE: catalog }).resolve(spec),
  };

  const bundle = createWorkspace({
    sql,
    transactions: deps.ctx,
    generation: workspaceGenerationStorage(sql),
    // The fabric mints each facet's `env.SUPERVISOR`, and `ctx.exports` comes off `transactions` (the DO's
    // own `ctx`). Without both, `git clone` refuses.
    fabric: HOST_FABRIC_COMPOSITION,
    runtimeSource,
  });

  if (deps.onFilesChanged) bundle.onFilesChanged(deps.onFilesChanged);

  // One registry per isolate: a port is a live listener in this isolate's memory.
  const portRegistry = new PortRegistry();
  let composing: Promise<HostComposition> | undefined;

  // This object's alarm slot is the SDK scheduler's, so tasks run on a timer plus waitUntil. Timers die with
  // a hibernated isolate, hence the launch pump also runs once per incarnation.
  const pending = new Map<HostedRuntimeTask, { timer: ReturnType<typeof setTimeout>; settle: (run: boolean) => void }>();

  const lifecycle: HostedRuntimeOptions['lifecycle'] = {
    waitUntil: (task) => { deps.ctx.waitUntil(task); },
    schedule: async (reason, at) => {
      pending.get(reason)?.settle(false);
      const sleep = Promise.withResolvers<boolean>();
      const timer = setTimeout(() => { pending.delete(reason); sleep.resolve(true); }, Math.max(0, at - Date.now()));
      pending.set(reason, { timer, settle: sleep.resolve });
      deps.ctx.waitUntil(sleep.promise.then(async (run) => {
        if (run) await (await compose()).runtime.onScheduled(reason);
      }));
    },
    cancel: async (reason) => {
      const held = pending.get(reason);

      if (held === undefined) return;
      clearTimeout(held.timer);
      pending.delete(reason);
      held.settle(false);
    },
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
          NIMBUS_RUNTIME_CACHE: catalog,
        };

        const runtime = await composeHostedRuntime({
          workspace: session.workspace,
          ctx: deps.ctx,
          env: runtimeBindings,
          ports: portRegistry,
          lifecycle,
          resolveWorkerLaunch: (recipe) => resolveSlateLaunch(deps, recipe),
        });

        // Cold-start recovery of launches a reset or hibernation interrupted.
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

  const files = workspaceBoxFiles(async () => (await bundle.session()).vfs);
  const boxes = new Map<string, NimbusSandboxHandle>();

  return {
    bundle,
    async supervisorOp(envelope: WireSupervisorEnvelope): Promise<SupervisorOpResult> {
      if (!servesOp(envelope)) {
        throw new KinuError('bad_input', `supervisor op: '${envelope.op}' names no operation this host serves`);
      }

      return (await runtime()).supervisorOp(envelope);
    },
    box(shellId) {
      const held = boxes.get(shellId);

      if (held) return held;
      const built = workspaceBox({ runtime, ports: portRegistry, ctx: deps.ctx, files, shellId, previewUrl: deps.previewUrl });
      boxes.set(shellId, built);

      return built;
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
      async reserved(owner) {
        const held = await readPortReservationByOwner(deps.ctx, owner);

        return held === null || held.reservation.capability === null
          ? null
          : { port: held.port, capability: held.reservation.capability };
      },
      async remove(owner) {
        const removed = await (await runtime()).removeApp({ owner });

        return { removed: removed.removed, port: removed.port };
      },
    },
    async routePreview(port, handle, request, pathname) {
      // Every refusal names its branch: a bare 404 is otherwise indistinguishable from the runner's own.
      const refused = (reason: string, owner: string | null, detail = ''): void => {
        diagnostics.event('preview.route.refused', { port, handle, reason, owner: owner ?? '', detail });
      };

      // Checked against the durable record: a port never handed a URL is a 404 even if something listens.
      const exposure = await readPortExposure(deps.ctx, port);

      if (exposure === null) {
        refused('no-exposure', null);

        return previewNotFound();
      }

      if (exposure.capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH) !== handle) {
        refused('handle-mismatch', exposure.owner);

        return previewNotFound();
      }

      if (exposure.owner !== null) {
        const refusal = await deps.ensureSlate?.(exposure.owner) ?? null;

        if (refusal !== null) {
          refused(refusal.reason === 'missing' ? 'ensure-missing' : 'ensure-unavailable', exposure.owner, refusal.error);

          return refusal.reason === 'missing' ? previewNotFound() : previewUnavailable(refusal);
        }
      }

      const listener = portRegistry.get(port);

      if (listener === undefined) {
        refused('no-listener', exposure.owner);
      } else if (listener.capability !== exposure.capability) {
        const state = (await bundle.session()).processes.get(listener.pid)?.state ?? 'absent';

        refused('capability-mismatch', exposure.owner, `pid=${String(listener.pid)} state=${state}`);
      }

      const publicRequest = new Request(request);
      // Drop the visitor's header first: naming the invocation stops retained preview bindings standing in
      // for a deeper lineage.
      publicRequest.headers.delete('x-slate-call');
      const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      const invocation = deps.slateInvocation?.(port, upgrade) ?? null;

      if (invocation !== null) publicRequest.headers.set('x-slate-call', invocation.value);
      const { facets } = await compose();

      try {
        const response = await facets.apps.routeCapabilityPort(port, exposure.capability, publicRequest, pathname);

        // A 101 only opens the socket: the process's close listener releases the invocation.
        if (response.status !== 101) invocation?.release();

        return response;
      } catch (cause) {
        invocation?.release();
        throw cause;
      }
    },
    destroy: () => bundle.destroy(),
  };
}

async function json(result: Promise<unknown>): Promise<JsonValue | undefined> {
  const value = await result;

  return value === undefined ? undefined : decodeJsonValue({ value });
}

function workspaceBox(deps: {
  runtime: () => Promise<HostedRuntime>;
  ports: PortRegistry;
  ctx: DurableObjectState;
  files: NimbusSandboxHandle['files'];
  shellId: string;
  previewUrl(port: number, capability: string): Promise<WorkspacePreviewUrl>;
}): NimbusSandboxHandle {
  const { runtime, shellId } = deps;

  return {
    ready: async () => { await (await runtime()).ready(); },
    // Each actor's work runs in its own named durable shell.
    exec: async (command, options): Promise<NimbusExecResult> =>
      await (await runtime()).exec(command, { ...options, shellId }),
    startProcess: async (command, options): Promise<NimbusStartResult> =>
      await (await runtime()).startProcess(command, { ...options, shellId }),
    runCode: async (code, options): Promise<NimbusExecResult> =>
      await (await runtime()).runCode(code, { ...options, shellId }),
    files: deps.files,
    runtimes: {
      ensure: async (specs, options) => await json(
        (await runtime()).ensureRuntimes(Array.isArray(specs) ? [...specs] : [specs], options),
      ),
      install: async (spec, options) => await json((await runtime()).installRuntime(spec, options)),
      list: async () => await json((await runtime()).listRuntimes()),
    },
    processes: {
      list: async () => await json((await runtime()).listProcesses()),
      kill: async (pid) => await json((await runtime()).killProcess(pid)),
      logs: async (pid, options) => await json((await runtime()).processLogs(pid, options)),
    },
    ports: {
      expose: async (port) => {
        const exposed = await (await runtime()).exposeApp({ port });

        if (exposed.capability === null) throw new Error(`No process is listening on workspace port ${port}`);
        const answer = await deps.previewUrl(port, exposed.capability);

        if (answer.url === undefined) {
          throw new KinuError('unsupported', `workspace port ${port} is listening and has no preview URL: ${answer.unavailable}`);
        }

        return { port: exposed.port, pid: exposed.pid, capability: exposed.capability, url: answer.url };
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
  };
}
