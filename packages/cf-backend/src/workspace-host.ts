/**
 * The hosted workspace, in the Durable Object that owns it.
 *
 * ONE DURABLE OBJECT PER WORKSPACE. Nimbus is held as a library over
 * `ctx.storage.sql`: the filesystem tables sit beside the actor's conversation,
 * its ledgers, its memory index and its fork lineage, so a write to
 * `memory/MEMORY.md` and the FTS5 rows that index it commit under one
 * `transactionSync`, a SQL-only snapshot of this object contains the workspace,
 * and deleting a workspace is one object's teardown rather than a three-step
 * cross-object sequence with no transaction around it.
 *
 * WHAT COMES FROM WHERE
 *
 * `@kinu.run/core/workspace` composes the filesystem and the shell — the same
 * `createWorkspace` the local CLI runs, so there is one recipe and not one per
 * backend. What a Durable Object has and a `bun` process does not — background
 * processes held open by `ctx.waitUntil`, a port registry, capability-routed
 * previews, an R2 runtime catalogue, wasm interpreters in dynamic-worker
 * facets, an xterm shell, durable per-actor shell state in `ctx.storage` — is
 * Nimbus's own hosted runtime (`composeHostedRuntime`), composed over that
 * workspace itself (see `WorkspaceSession.workspace`). Nothing is
 * reimplemented on either side of that line.
 *
 * WHAT A FACET SEES
 *
 * A subordinate or an exploration head runs in its own Durable Object facet with
 * its own SQLite, and shares the WORKSPACE — the same SOUL.md, the same
 * `memory/`, the same tree. So a facet does not compose a workspace of its own;
 * it holds {@link createWorkspaceBoxClient}, which is the same
 * `NimbusSandboxHandle` over one RPC into the orchestrator that owns the bytes.
 * Both boxes satisfy the same interface, so `nimbusSessionFiles`,
 * `nimbusSessionShell`, `createNimbusWorkspaceExecutor` and the node-home
 * provisioner are built identically wherever they run.
 *
 * WHAT A HOSTED WORKSPACE CAN RUN
 *
 * Files, POSIX shell, coreutils, package installation, isomorphic git, `node`
 * programs and the interpreters the R2 catalogue holds (`python3`, `bash`,
 * `ruby`), each in a dynamic-worker facet of the hosted runtime. Bundled
 * Worker modules run as resident Fabric processes; native Linux workloads use
 * the sandbox container.
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
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import type { ComposedFacetManager, HostedRuntime, HostedRuntimeOptions, HostedRuntimeTask, WorkerRecipe } from '@nimbus-sh/worker/workspace-host';
import { clearPortCapability, readPortExposure, readPortReservationByOwner, releasePortReservation } from '@nimbus-sh/worker/port-capability';
import type { DurableApps } from '@kinu.run/core/slates';
import * as v from 'valibot';

/**
 * The fabric every workspace this Worker hosts is composed with.
 *
 * A facet runs in its own isolate and reaches the object that owns the
 * filesystem through the supervisor entrypoint — and the entrypoint can only
 * mint that binding from `ctx.exports` against a composed name, and can only
 * reach the host through a composed namespace and method. Each half names
 * something Kinu already has: `SupervisorRPC` is re-exported from
 * `server.ts`, `OrchestratorAgent` is this deployment's own Durable Object
 * namespace binding, and `supervisorOp` is the one method the orchestrator
 * mounts for its facets. `NIMBUS_SESSION` is deliberately NOT named: the
 * class is gone (wrangler.jsonc migrations `v3`) and no binding carries that
 * name, so composing it would point every facet at a namespace that does not
 * exist. `hostDispatchMethod` repeats the default on purpose — a reader must
 * not have to know the default to see which method a facet lands on.
 */
const HOST_FABRIC_COMPOSITION: FabricComposition = {
  supervisorEntrypoint: 'SupervisorRPC',
  hostNamespace: 'OrchestratorAgent',
  hostDispatchMethod: 'supervisorOp',
};

/**
 * The one `LOADER` binding, as the fabric declares it.
 *
 * Both names describe the binding workerd hands this Worker: the platform's
 * `WorkerLoader` and the fabric's vendored one differ only in that the
 * fabric's `globalOutbound` stub omits `connect`, which every real service
 * binding carries. Wrapping the stub would replace the binding with a plain
 * object workerd refuses as an outbound, so the binding crosses as itself,
 * checked for the one member the fabric calls.
 */
type FabricWorkerLoader = NonNullable<HostedRuntimeOptions['env']['LOADER']>;

const FabricWorkerLoaderSchema = v.custom<FabricWorkerLoader>(
  (value) => v.is(v.object({ get: v.function() }), value),
  'the LOADER binding must be a worker loader',
);

function fabricLoader(loader: WorkerLoader): FabricWorkerLoader {
  return v.parse(FabricWorkerLoaderSchema, loader);
}

/** The bindings the runtime reads: the fabric's host namespace beside the
 *  loader, the assets and the runtime catalogue its own env type names. */
type HostedRuntimeBindings = HostedRuntimeOptions['env'] & { readonly OrchestratorAgent: Env['OrchestratorAgent'] };

/**
 * The hosted runtime's module, loaded on first composition rather than at
 * module eval: its static graph carries isomorphic-git, the npm installer, the
 * REPLs and the substrate's wasm-adjacent machinery. Every consumer already
 * awaits the workspace host before reaching any of it, so the import belongs
 * to that first await, and module eval stays clean for the Worker's cold
 * start and the workerd test pool's loader.
 */
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

/**
 * A read whose only tolerated failure is "there is no such path".
 *
 * ENOENT is how the filesystem reports a missing path, and every SDK-shaped file
 * read answers `null` for exactly that case: `null` is a fact the caller acts on,
 * while a permission failure or a torn chunk is not something to report as
 * absence. Synchronous on purpose — the durable filesystem is, so the throw
 * happens on this stack and nothing has to inspect a rejection.
 *
 * The tolerance is declared through `obs`, not matched on rendered text.
 * Rendered text reports a directory as absent when its path holds the
 * substring. The VFS sets `code` on every error it raises, and this reads
 * that.
 */
function absentAsNull<T>(read: () => T): T | null {
  return tolerate(read, 'enoent') ?? null;
}

/**
 * The workspace's files in the SDK handle's shape, straight off the durable
 * filesystem.
 *
 * The raw `SqliteVFS`, credentialed as the session user, is what the Nimbus
 * session's own pid-less file RPCs resolve to — so this is the same identity
 * reading the same rows, with the round trip removed. `stat`, `rename`, `chmod`,
 * a recursive removal and a byte-exact read are native operations here rather
 * than the shell-outs a remote handle needs.
 */
function workspaceBoxFiles(open: () => Promise<SqliteVFS>, cred: VfsCred = CRED_SESSION_USER): NimbusSandboxHandle['files'] {
  const view = async (): Promise<CredentialedVfs> => (await open()).as(cred);

  return {
    // The same rows as one agent: the raw filesystem credentialed to it,
    // exactly the view its commands run under.
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
      // The SDK write contract creates missing parents — the remote session's
      // pid-less write always did, and bootstrapScaffold writes
      // `scaffold/agent.js` into a fresh workspace with no mkdir of its own.
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

      // A non-recursive delete of a directory is `rmdir`, which refuses a
      // populated one — the same distinction `rm` and `rmdir` draw, kept because
      // the SDK surface has one method for both.
      if (vfs.isDirectory(path)) {
        vfs.rmdir(path);

        return;
      }

      vfs.unlink(path);
    },
  };
}

export interface HostedWorkspaceDeps {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  /**
   * The public URL an exposed port is reachable at, or the reason there is
   * none. Supplied by the actor because a preview URL names the workspace and
   * is signed with a key derived from the user-plane secret, neither of which
   * the workspace itself has any business holding.
   */
  previewUrl(port: number, capability: string): Promise<WorkspacePreviewUrl>;
  onFilesChanged?(paths: readonly string[]): void;
  /**
   * Bring the slate that owns a durable application to life: the process a
   * reset took is re-driven, a process whose source changed is replaced, a
   * live one is answered as it is. Asked before a preview request is routed
   * to its port, and again by the launch journal on the wake after a reset
   * or a hibernation took a launch (`resolveWorkerLaunch` below). A refusal
   * says why the slate cannot serve — `missing` once its tree is gone, the
   * compiler's `bad_input` when its source is broken.
   */
  ensureSlate?(owner: string): Promise<Refusal | null>;
  /** Mint the app invocation a preview request runs under, so a slate cannot
   *  keep its bindings and replay them as an unnamed root lineage. `socket`
   *  marks the invocation for the WebSocket case: it must outlive the routed
   *  response, which a 101 only opens. */
  slateInvocation?(port: number, socket: boolean): { readonly value: string; release: () => void } | null;
}

/** What one composition yields: Nimbus's hosted runtime, the facet manager it carries, and the registry both register into. */
interface HostComposition {
  readonly runtime: HostedRuntime;
  readonly facets: ComposedFacetManager;
  readonly ports: PortRegistry;
}

/** The runtime's terminal surface, as this host exposes it to the actor. */
export type WorkspaceTerminal = Pick<HostedRuntime, 'attachTerminal' | 'terminalFrame' | 'terminalClose'>;

export interface HostedWorkspace {
  /** The filesystem and the shell, as `Storage.vfs` and every file surface
   *  consume them. */
  readonly bundle: WorkspaceBundle;
  /**
   * The process/port/runtime/exec plane, with commands running in the named
   * durable shell.
   *
   * One box per actor and cached by `shellId`, because a named shell HOLDS a
   * working directory and exported variables: the orchestrator's `agent:main`,
   * a subordinate's `subordinate:<name>` and a head's `head:<id>` each keep
   * their own `cd` across calls over one filesystem and one process table.
   */
  box(shellId: string): NimbusSandboxHandle;
  /**
   * The one method a workspace host mounts for its facets, answered by the
   * composed HOSTED RUNTIME.
   *
   * Half of the operations an envelope can carry are filesystem ops a bare
   * workspace serves; the other half — `fanoutExecute`, `hostProcess`,
   * `cpSpawn`, `writeBatch`, `registerPort`, `routeLoopback` and the rest of
   * `SUPERVISOR_OP_ROUTES` — are HOST ops, and only the runtime has the
   * methods behind them. Answering from the workspace alone refused every one
   * of them.
   *
   * It holds for EVERY name this object is opened under. Nimbus opens
   * siblings of the host namespace by name for the npm resolver's wide layers
   * and for peer process hosting, and a sibling answers this same method; it
   * is a runtime over its own scratch storage, never a Kinu workspace, so
   * nothing here claims an owner or writes a transcript. Composing it boots
   * the workspace exactly as the first file touch does, through the same
   * memoized open with the same failure-clearing retry.
   */
  supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult>;
  /**
   * The facet manager composed over this object — the slate host's spawn
   * and kill path, and the one registrar of a resident's port: it binds the
   * port a durable launch declared and decides, against the owner's
   * reservation, whether the port's stored capability is re-adopted or
   * retired. Composing it opens the workspace, exactly as the first file
   * touch does.
   */
  facetManager(): Promise<ComposedFacetManager>;
  /** The live listeners of this isolate, the registry the manager registers into. */
  ports(): Promise<PortRegistry>;
  /**
   * The runtime's own xterm shell over its WebSocket protocol: `attach` on
   * accept, `frame` per message, `close` when the socket goes. One terminal
   * per workspace, as Nimbus keeps it; a second attach replaces the first.
   */
  terminal(): Promise<WorkspaceTerminal>;
  readonly apps: DurableApps;
  /**
   * Route a preview request whose signed hostname the edge has already
   * verified. `handle` is the capability prefix that hostname carried — the full
   * capability never leaves this object.
   */
  routePreview(port: number, handle: string, request: Request, pathname: string): Promise<Response>;
  /** Drop the workspace's own tables, leaving the actor's rows alone. */
  destroy(): Promise<void>;
}

/**
 * How much of a port capability the public hostname carries.
 *
 * Enough to PIN a URL to one exposure — unexposing and re-exposing a port mints
 * a fresh capability, so an old link stops resolving — and no more, because the
 * capability is the secret this object checks while the hostname is a public DNS
 * label already carrying a signed token and the workspace's own name. The full
 * 24-hex capability would not fit beside them; its first 10 characters do.
 */
export const PREVIEW_CAPABILITY_HANDLE_LENGTH = 10;

/** A URL that names nothing this object serves. Never a 403: a wrong handle
 *  must not confirm that the port is listening at all. */
function previewNotFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

/**
 * The slate behind a durable URL could not be brought to life: its source no
 * longer compiles, or its boot was refused. The refusal is the body, so the
 * visitor sees the compiler's own words rather than a blank page, and the
 * status invites a retry once the author has fixed the tree.
 */
function previewUnavailable(refusal: Refusal): Response {
  return new Response(JSON.stringify({ reason: refusal.reason, error: refusal.error }), {
    status: 503,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json', 'retry-after': '3' },
  });
}

/**
 * How a journalled worker launch is re-driven here.
 *
 * Every worker the slate host spawns is journalled under the slate that owns
 * it, and the journal re-drives a row a reset or a hibernation interrupted
 * through this hook. What a row carries is the recipe — image digests, port,
 * cwd — and never the launch's inputs: a slate's bindings are minted per
 * caller by the slate host and its modules are compiled from the tree as it
 * is now, so those inputs are not re-resolved from the row. The slate host
 * re-drives the application through its own boot instead — the same path a
 * request on its URL takes, which also replaces a process whose source
 * changed — and the row this re-drive was owed on is released by answering
 * null. An interpreter resident (`recipe.resident`) is the session's own
 * launch and never an embedder's; the guard keeps that true here.
 */
/** A thrown re-drive inside `waitUntil` would otherwise vanish: the refusal
 *  value is the slate's own answer, this is the host failing to ask. Named so
 *  the rejection arm has a typed parameter. */
const redriveFailed = (owner: string) => <Failure>(cause: Failure): void => {
  diagnostics.failure('workspace.facet.redrive_failed', toKinuError({
    doing: 're-driving a slate launch a hibernation interrupted', cause, otherwise: 'io',
  }), { owner });
};

function resolveSlateLaunch(deps: HostedWorkspaceDeps, recipe: WorkerRecipe): Promise<null> {
  if (recipe.resident !== undefined || deps.ensureSlate === undefined) return Promise.resolve(null);

  deps.ctx.waitUntil(deps.ensureSlate(recipe.owner).then((refusal) => {
    if (refusal !== null) {
      diagnostics.event('workspace.facet.redrive_refused', { owner: recipe.owner, reason: refusal.reason, error: refusal.error });
    }
  }, redriveFailed(recipe.owner)));

  return Promise.resolve(null);
}

/**
 * Compose the workspace this Durable Object owns.
 *
 * Called once per isolate, lazily — `workspaceGenerationStorage` bumps a durable
 * counter, and the filesystem itself does not open until the first operation
 * touches it, so an activation that never reads a file pays for neither.
 */
export function createHostedWorkspace(deps: HostedWorkspaceDeps): HostedWorkspace {
  const sql = deps.ctx.storage.sql;
  const catalog = deps.env.NIMBUS_RUNTIME_CACHE;

  // The R2 catalogue, and nothing else of this env, is what the workspace's
  // install stubs resolve against: a name the registry cannot answer becomes
  // a command that installs on first use, exactly as the CLI's packaged
  // runtimes do. The source reads the module lazily, as every reach into the
  // runtime here does, so an unopened workspace loads none of it.
  const runtimeSource: RuntimeSource | undefined = catalog === undefined ? undefined : {
    list: async () => (await hostedRuntimeModule()).runtimeCatalogSource({ NIMBUS_RUNTIME_CACHE: catalog }).list(),
    resolve: async (spec) => (await hostedRuntimeModule()).runtimeCatalogSource({ NIMBUS_RUNTIME_CACHE: catalog }).resolve(spec),
  };

  const bundle = createWorkspace({
    sql,
    transactions: deps.ctx,
    generation: workspaceGenerationStorage(sql),
    // What makes this object a workspace HOST rather than a bare filesystem
    // holder: the fabric mints every facet's `env.SUPERVISOR` binding, and
    // `ctx.exports` is adopted off `transactions` — which here IS the Durable
    // Object's own `ctx`, the object workerd hangs `exports` on. Without both
    // halves `git clone` refuses before it spawns anything.
    fabric: HOST_FABRIC_COMPOSITION,
    runtimeSource,
  });

  if (deps.onFilesChanged) bundle.onFilesChanged(deps.onFilesChanged);

  // One registry per isolate, exactly as a session has one: a port is a live
  // listener in this isolate's memory. What survives an eviction is Nimbus's
  // reservation record in `ctx.storage` and the manager's launch journal.
  const portRegistry = new PortRegistry();
  let composing: Promise<HostComposition> | undefined;

  // The runtime's scheduling, on this object's timers. The runtime drives its
  // launch pump, log flush and log janitor through `schedule`; a session owns
  // its object's one alarm slot and arms that, while this object's slot is
  // the SDK scheduler's, so a timer plus waitUntil takes each task onto a
  // fresh turn instead. A timer dies with a hibernated isolate, which is why
  // the launch pump also runs once per incarnation below: the journal rows
  // it drains are what a dead timer left owed. One pending timer per reason,
  // and a re-schedule replaces it.
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

        // The runtime composes the facet manager itself, over this object's
        // ctx, its env and the workspace's own process owner and registry;
        // it registers `git`, `node`, the interpreter runners and their
        // REPLs, and starts the workspace. This host supplies what only it
        // has: the bindings the runtime reads, the launch re-drive for the
        // slates it owns, and the scheduling above.
        const runtimeBindings: HostedRuntimeBindings = {
          OrchestratorAgent: deps.env.OrchestratorAgent,
          LOADER: fabricLoader(deps.env.LOADER),
          ASSETS: deps.env.ASSETS,
          NIMBUS_RUNTIME_CACHE: catalog,
        };

        const runtime = await composeHostedRuntime({
          workspace: session.workspace,
          ctx: deps.ctx,
          // The bindings the runtime reads and no other: handing over the
          // actor's whole Env would put every binding it holds inside a
          // package manager and a dynamic-worker loader.
          env: runtimeBindings,
          ports: portRegistry,
          lifecycle,
          resolveWorkerLaunch: (recipe) => resolveSlateLaunch(deps, recipe),
        });

        // The first pump of an incarnation drains the launch journal's
        // cold-start recovery: a launch a reset or a hibernation interrupted
        // is re-driven here, on the wake that composed this runtime.
        deps.ctx.waitUntil(runtime.onScheduled('resident-launch'));

        return { runtime, facets: runtime.facets(), ports: portRegistry };
      } catch (cause) {
        // Same rule as the bundle's `booting` and `planes`: this host lives for
        // the whole actor isolate, and a cached rejection would poison every
        // later box op and preview route on one transient failure while each
        // user retry resets the eviction timer that is the only other way out.
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
    async supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult> {
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

        // The declaration moved: the identity moves with it. The old
        // reservation is released — never silently kept beside a port the
        // author no longer named — and a fresh port and capability are minted
        // below. The facet slot is untouched, so the application's own
        // storage follows it to the new address.
        if (held !== null && preferredPort !== undefined && held.port !== preferredPort) {
          await releasePortReservation(deps.ctx, { owner, port: held.port });
        }

        const reserved = await facets.apps.ensureDurableApp({ owner, preferredPort, visibility: 'scoped' });

        if (reserved.capability === null) {
          throw new KinuError('io', `Nimbus reserved workspace port ${reserved.port} for ${owner} without a capability`);
        }

        return { port: reserved.port, capability: reserved.capability };
      },
      // Straight off the reservation record, with no session composed and no
      // process driven: a capability is minted when the application is first
      // reserved, so a held one is enough to build its URL from.
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
      // Every refusal below names its branch: a bare 404 on a durable URL is
      // otherwise indistinguishable from the runner's own, and that silence
      // hid a live regression on 2026-09-14.
      const refused = (reason: string, owner: string | null, detail = ''): void => {
        diagnostics.event('preview.route.refused', { port, handle, reason, owner: owner ?? '', detail });
      };

      // The URL was minted from the durable record, so the record is what the
      // handle is checked against — a port nothing was ever handed a URL for
      // is a 404 whether or not something listens on it now.
      const exposure = await readPortExposure(deps.ctx, port);

      if (exposure === null) {
        refused('no-exposure', null);

        return previewNotFound();
      }

      if (exposure.capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH) !== handle) {
        refused('handle-mismatch', exposure.owner);

        return previewNotFound();
      }

      // A durable application answers its URL whether or not its process
      // survived: the owner is brought to life (or replaced, when its source
      // changed) before anything is routed. A port exposed without an owner
      // has nothing to re-drive and is served only while it listens.
      if (exposure.owner !== null) {
        const refusal = await deps.ensureSlate?.(exposure.owner) ?? null;

        if (refusal !== null) {
          refused(refusal.reason === 'missing' ? 'ensure-missing' : 'ensure-unavailable', exposure.owner, refusal.error);

          return refusal.reason === 'missing' ? previewNotFound() : previewUnavailable(refusal);
        }
      }

      // What Nimbus's registry holds for the port at routing time: the listener
      // it will consult, or nothing, which is the one reason its route answers
      // a bare 404 (`routeCapabilityRequest` returns null without a live entry
      // whose capability matches).
      const listener = portRegistry.get(port);

      if (listener === undefined) {
        refused('no-listener', exposure.owner);
      } else if (listener.capability !== exposure.capability) {
        const state = (await bundle.session()).processes.get(listener.pid)?.state ?? 'absent';

        refused('capability-mismatch', exposure.owner, `pid=${String(listener.pid)} state=${state}`);
      }

      const publicRequest = new Request(request);
      // The visitor's own header is dropped first, then the host names this
      // request's invocation. A preview entry is a root lineage, and naming it
      // is what stops retained preview bindings standing in for a deeper one.
      publicRequest.headers.delete('x-slate-call');
      const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      const invocation = deps.slateInvocation?.(port, upgrade) ?? null;

      if (invocation !== null) publicRequest.headers.set('x-slate-call', invocation.value);
      const { facets } = await compose();

      // Nimbus routes with the WHOLE capability and checks it against the live
      // registration itself; this object only ever compared the handle. The
      // composed apps answer upgrades and plain fetches alike — the manager
      // is in-process, so a 101 never has to cross an RPC boundary.
      try {
        const response = await facets.apps.routeCapabilityPort(port, exposure.capability, publicRequest, pathname);

        // A 101 only OPENS the socket session: the invocation stays minted
        // for its life, released by the process's close listener — releasing
        // here would retire it before the first frame arrives.
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

/** `runtimes.*` and `processes.*` answer with whatever the catalogue or the
 *  process table holds, and the executor renders it as JSON. One decode, so an
 *  unexpected shape is a named failure rather than an `[object Object]`. */
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
    // `shellId` on every command: each actor's work goes into ITS named durable
    // shell, which is what makes `cd` persist for it and stay invisible to its
    // siblings.
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
      // A listening port with no URL is refused with the reason, under the
      // same code sandbox.ts gives a container whose previews are not
      // configured: the port works, the deployment cannot address it, and a
      // retry cannot change that.
      expose: async (port) => {
        const exposed = await (await runtime()).exposeApp({ port });

        if (exposed.capability === null) throw new Error(`No process is listening on workspace port ${port}`);
        const answer = await deps.previewUrl(port, exposed.capability);

        if (answer.url === undefined) {
          throw new KinuError('unsupported', `workspace port ${port} is listening and has no preview URL: ${answer.unavailable}`);
        }

        return { port: exposed.port, pid: exposed.pid, capability: exposed.capability, url: answer.url };
      },
      // The capability is retired before the listener is dropped, so a crash
      // between the two leaves a dead token rather than a live one.
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
