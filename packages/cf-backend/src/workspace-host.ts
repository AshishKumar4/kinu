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
 * previews, an R2 runtime catalogue, durable per-actor shell state in
 * `ctx.storage` — is Nimbus's own programmatic session surface, composed over
 * that workspace's shell, filesystem, command registry and process owner (see
 * `WorkspaceSession`). Nothing is reimplemented on either side of that line.
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
 * Files, POSIX shell, coreutils, package installation, and isomorphic git.
 * The hosted node shim cannot run programs: workerd blocks its request-time
 * string compiler (core/src/vfs/workspace-runtimes.ts). Bundled Worker modules
 * run as resident Fabric processes; npm dev servers use the sandbox container.
 */

import { createWorkspace, nextWorkspaceGeneration } from '@kinu.run/core/workspace';
import type { SupervisorOpResult, WorkspaceBundle, WorkspaceSession } from '@kinu.run/core/workspace';
import { decodeJsonValue } from '@kinu.run/core';
import type {
  JsonValue,
  NimbusExecResult, NimbusPortInfo, NimbusSandboxHandle, NimbusStartResult, WorkspacePreviewUrl,
} from '@kinu.run/core';
import { diagnostics, KinuError, tolerate, type Refusal } from '@kinu.run/core/obs';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { RouteableFacetTarget } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { composeFacetManager, type ComposedFacetManager, type WorkerRecipe } from '@nimbus-sh/worker/workspace-host';
import {
  clearPortCapability,
  readPortExposure,
  readPortReservationByOwner,
  releasePortReservation,
  restoreReservedPortCapability,
} from '@nimbus-sh/worker/port-capability';
import { HOST_FABRIC_COMPOSITION, facetDiagnosticsHooks, nimbusProgrammatic, type ProgrammaticHost } from './nimbus-programmatic';
import type { DurableApps } from '@kinu.run/core/slates';

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
function workspaceBoxFiles(open: () => Promise<CredentialedVfs>): NimbusSandboxHandle['files'] {
  return {
    async read(path) {
      const vfs = await open();

      return absentAsNull(() => vfs.readFileString(path));
    },
    async readBytes(path) {
      const vfs = await open();

      return absentAsNull(() => vfs.readFile(path));
    },
    async readRange(path, offset, length) {
      const vfs = await open();

      return absentAsNull(() => vfs.readRange(path, offset, length));
    },
    async write(path, content) {
      const vfs = await open();
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
      const vfs = await open();

      return absentAsNull(() => {
        const stat = vfs.stat(path);

        return { type: stat.type, size: stat.size, mtime: stat.mtime };
      });
    },
    async lstat(path) {
      const vfs = await open();

      return absentAsNull(() => {
        const stat = vfs.lstat(path);

        return { type: stat.type, size: stat.size, mtime: stat.mtime, mode: stat.mode };
      });
    },
    async rename(from, to) { (await open()).rename(from, to); },
    async chmod(path, mode) { (await open()).chmod(path, mode); },
    async list(path) {
      return (await open()).readdir(path ?? '/').map((entry) => ({ name: entry.name, type: entry.type }));
    },
    async exists(path) { return (await open()).exists(path); },
    async mkdir(path) { (await open()).mkdir(path, { recursive: true }); },
    async delete(path, options) {
      const vfs = await open();

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

/** The two halves one composition yields: Nimbus's programmatic host and the facet manager it carries. */
interface HostComposition {
  readonly programmatic: ProgrammaticHost;
  readonly facets: ComposedFacetManager;
}

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
   * The one method a workspace host mounts for its facets, forwarded to the
   * workspace's own dispatch. The orchestrator's mounted method delegates
   * here, and this answers against the booted workspace — so the first facet
   * call boots the workspace exactly like any other first touch, through the
   * same memoized open with the same failure-clearing retry.
   */
  supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult>;
  /**
   * A resident process has bound its port. `owner` is the durable identity it
   * serves; the reservation Nimbus holds for that owner is what decides
   * whether the port's stored capability is re-adopted or retired.
   */
  registerPort(pid: number, port: number, target: RouteableFacetTarget, owner: string): Promise<void>;
  unregisterPorts(pid: number): void;
  /**
   * The facet manager composed over this object — the slate host's spawn
   * and kill path. Composing it opens the workspace, exactly as the first
   * file touch does.
   */
  facetManager(): Promise<ComposedFacetManager>;
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
function resolveSlateLaunch(deps: HostedWorkspaceDeps, recipe: WorkerRecipe): Promise<null> {
  if (recipe.resident !== undefined || deps.ensureSlate === undefined) return Promise.resolve(null);

  deps.ctx.waitUntil(deps.ensureSlate(recipe.owner).then((refusal) => {
    if (refusal !== null) {
      diagnostics.event('workspace.facet.redrive_refused', { owner: recipe.owner, reason: refusal.reason, error: refusal.error });
    }
  }));

  return Promise.resolve(null);
}

/**
 * Compose the workspace this Durable Object owns.
 *
 * Called once per isolate, lazily — `nextWorkspaceGeneration` bumps a durable
 * counter, and the filesystem itself does not open until the first operation
 * touches it, so an activation that never reads a file pays for neither.
 */
export function createHostedWorkspace(deps: HostedWorkspaceDeps): HostedWorkspace {
  const sql = deps.ctx.storage.sql;

  const bundle = createWorkspace({
    sql,
    transactions: deps.ctx,
    generation: nextWorkspaceGeneration(sql),
    // What makes this object a workspace HOST rather than a bare filesystem
    // holder: the fabric mints every facet's `env.SUPERVISOR` binding, and
    // `ctx.exports` is adopted off `transactions` — which here IS the Durable
    // Object's own `ctx`, the object workerd hangs `exports` on. Without both
    // halves `git clone` refuses before it spawns anything.
    fabric: HOST_FABRIC_COMPOSITION,
  });

  if (deps.onFilesChanged) bundle.onFilesChanged(deps.onFilesChanged);

  // One registry per isolate, exactly as a session has one: a port is a live
  // listener in this isolate's memory. What survives an eviction is Nimbus's
  // reservation record in `ctx.storage` and the manager's launch journal.
  const portRegistry = new PortRegistry();
  let composing: Promise<HostComposition> | undefined;

  const compose = async (): Promise<HostComposition> => {
    composing ??= (async (): Promise<HostComposition> => {
      try {
        const session = await bundle.session();

        // The session's own `ensureFacetManager` composes through the same
        // factory — the published entry point is the composition, so this host
        // carries only its own environment and hooks, not the manager wiring.
        const composed = composeFacetManager({
          ctx: deps.ctx,
          env: deps.env,
          processes: session.processes,
          portRegistry,
          vfs: session.vfs,
          hooks: {
            ...facetDiagnosticsHooks(),
            // The session drives the pump with an alarm; this object's one
            // alarm slot is the SDK scheduler's, so a timer plus waitUntil
            // takes the pump onto a fresh turn instead. A timer dies with a
            // hibernated isolate, which is why the pump below runs once per
            // incarnation: the journal rows it drains are what a dead timer
            // left owed.
            requestLaunchTurn: (notBefore) => {
              const delay = notBefore === undefined ? 0 : Math.max(0, notBefore - Date.now());
              const sleep = Promise.withResolvers<void>();
              setTimeout(sleep.resolve, delay);
              deps.ctx.waitUntil(sleep.promise.then(() => composed.pumpLaunches()));
            },
            resolveWorkerLaunch: (recipe) => resolveSlateLaunch(deps, recipe),
          },
        });

        // The first pump of an incarnation drains the launch journal's
        // cold-start recovery: a launch a reset or a hibernation interrupted
        // is re-driven here, on the wake that composed this manager.
        deps.ctx.waitUntil(composed.pumpLaunches());
        // `git` is a REAL command here — registered, not a refusal. The
        // Durable Object context and env are what the NETWORK subcommands
        // (clone/fetch/pull/push) reach through the git-network facet; local
        // history needs neither, and both are real here. Registered the way
        // the session registers its own.
        const { runGitCommand } = await nimbusProgrammatic();
        session.registry.register('git', (command) => runGitCommand(command, session.vfs, deps.ctx, deps.env));

        // Nothing here refuses the network `git` subcommands or the fetching
        // `npm` subcommands. `git clone` and friends reach their dynamic-worker
        // facets through the composed fabric, and `npm install` streams in
        // process — one tarball entry at a time, never a buffered whole — so
        // neither exhausts this isolate.
        return { programmatic: buildProgrammaticHost(session, portRegistry, deps, composed), facets: composed };
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

  const host = async (): Promise<ProgrammaticHost> => (await compose()).programmatic;

  const files = workspaceBoxFiles(async () => (await bundle.session()).vfs.as(CRED_SESSION_USER));
  const boxes = new Map<string, NimbusSandboxHandle>();

  return {
    bundle,
    async supervisorOp(envelope: SupervisorOpEnvelope): Promise<SupervisorOpResult> {
      return (await bundle.session()).supervisorOp(envelope);
    },
    box(shellId) {
      const held = boxes.get(shellId);

      if (held) return held;
      const built = workspaceBox({ host, files, shellId, previewUrl: deps.previewUrl });
      boxes.set(shellId, built);

      return built;
    },
    async registerPort(pid, port, target, owner) {
      const occupied = portRegistry.get(port);

      if (occupied !== undefined && occupied.pid !== pid) throw new KinuError('io', `Workspace port ${port} is already in use`);

      portRegistry.bindFacetStub(pid, target);
      portRegistry.register(port, pid);
      // The capability is bound to identity, not to the port: the stored one
      // is re-adopted only when the reservation names this owner. Any other
      // occupant retires it, so a link handed out for the reservation's owner
      // 404s rather than reaching a program it was never minted for — the
      // owner's reservation itself survives.
      const adopted = await restoreReservedPortCapability({ ctx: deps.ctx, portRegistry }, port, owner);

      if (adopted === null) await clearPortCapability({ ctx: deps.ctx, portRegistry }, port);
    },
    unregisterPorts(pid) { portRegistry.unregisterByPid(pid); },
    facetManager: async () => (await compose()).facets,
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
      async remove(owner) {
        const removed = await (await compose()).facets.apps.removeDurableApp(owner);

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

/**
 * Nimbus's programmatic session host, over this workspace.
 *
 * `shell`, `sqliteFs`, `_cpRegistry` and `processes` are the workspace's OWN —
 * a second filesystem over one database is a second content cache, and a second
 * process table hands out pids whose append authority this filesystem has
 * already revoked. `initSession` therefore refuses: the session is composed, and
 * the boot path that would compose a second one must never run.
 */
function buildProgrammaticHost(
  session: WorkspaceSession,
  portRegistry: PortRegistry,
  deps: HostedWorkspaceDeps,
  facetManager: ComposedFacetManager,
): ProgrammaticHost {
  const storage = deps.ctx.storage;
  const catalog = deps.env.NIMBUS_RUNTIME_CACHE;

  return {
    _w1SessionDestroyed: false,
    // The runtime catalogue's bucket and nothing else: this env is read by
    // `nimbus install` alone, so handing over the actor's whole Env would put
    // every binding it holds inside a package manager.
    env: catalog ? { NIMBUS_RUNTIME_CACHE: catalog } : {},
    ctx: {
      // A background process's work is held open by the object that owns it,
      // which is this one.
      waitUntil: (promise) => { deps.ctx.waitUntil(promise); },
      getWebSockets: (tag) => deps.ctx.getWebSockets(tag),
      storage: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        // Narrowed to the port's own contract: Durable Object storage answers a
        // delete with whether a row was there, and no caller here reads that.
        delete: async (key) => { await storage.delete(key); },
        list: (options) => storage.list(options),
        // A port reservation is claimed and released inside ONE storage
        // transaction — the read, the owner check and the write — so a
        // concurrent claim on the same port cannot interleave. The real
        // Durable Object transaction is the only thing that makes that true.
        transaction: (body) => storage.transaction(body),
        // NEVER `storage.deleteAll()`. A session owns its Durable Object; a
        // workspace SHARES one, and the actor's conversation, ledgers and
        // identity are rows in the same SQLite. Destruction goes through
        // `HostedWorkspace.destroy`, which drops the workspace's tables only.
        deleteAll: async () => {
          throw new Error(
            'the hosted workspace shares its Durable Object with the actor: destroy it '
            + 'through HostedWorkspace.destroy, which drops only the workspace tables',
          );
        },
        // NEVER the real slot. A session that owned its object could clear its
        // own alarm; a workspace SHARES the actor's object, and the one slot
        // carries the SDK scheduler's wake for Kinu's timer chain. This shim
        // exposes no setAlarm, so the session never armed anything here and
        // "delete my alarm" is vacuously complete.
        deleteAlarm: async () => {},
      },
    },
    shell: session.shell,
    shellProcessPid: null,
    sqliteFs: session.vfs,
    processes: session.processes,
    portRegistry,
    // The one manager: what Nimbus's application verbs ask about a resident
    // process is answered from the launch journal it keeps itself.
    facetManager: facetManager.manager,
    facetManagerComposed: facetManager,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: session.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    ensureSqliteFs: () => undefined,
    ensureFacetManager: () => facetManager,
    initSession: async () => {
      throw new Error(
        'the hosted workspace is already composed; Nimbus must not boot a second session over it',
      );
    },
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
  host: () => Promise<ProgrammaticHost>;
  files: NimbusSandboxHandle['files'];
  shellId: string;
  previewUrl(port: number, capability: string): Promise<WorkspacePreviewUrl>;
}): NimbusSandboxHandle {
  const { host, shellId } = deps;

  return {
    ready: async () => { await (await nimbusProgrammatic()).ensureProgrammaticReady(await host()); },
    // `shellId` on every command: each actor's work goes into ITS named durable
    // shell, which is what makes `cd` persist for it and stay invisible to its
    // siblings. It rode a helper whose fixed return type dropped `runCode`'s own
    // two fields, so that call site re-assigned — one `if` per field — what the
    // spread had already copied.
    exec: async (command, options): Promise<NimbusExecResult> =>
      await (await nimbusProgrammatic()).rpcExec(await host(), command, { ...options, shellId }),
    startProcess: async (command, options): Promise<NimbusStartResult> =>
      await (await nimbusProgrammatic()).rpcStartProcess(await host(), command, { ...options, shellId }),
    runCode: async (code, options): Promise<NimbusExecResult> =>
      await (await nimbusProgrammatic()).rpcRunCode(await host(), code, { ...options, shellId }),
    files: deps.files,
    runtimes: {
      ensure: async (specs, options) => await json(
        (await nimbusProgrammatic()).rpcEnsureRuntimes(await host(), Array.isArray(specs) ? [...specs] : [specs], options),
      ),
      install: async (spec, options) => await json((await nimbusProgrammatic()).rpcInstallRuntime(await host(), spec, options)),
      list: async () => await json((await nimbusProgrammatic()).rpcListRuntimes(await host())),
    },
    processes: {
      list: async () => await json((await nimbusProgrammatic()).rpcListProcesses(await host())),
      kill: async (pid) => await json((await nimbusProgrammatic()).rpcKillProcess(await host(), pid)),
      logs: async (pid, options) => await json((await nimbusProgrammatic()).rpcProcessLogs(await host(), pid, options)),
    },
    ports: {
      // A listening port with no URL is refused with the reason, under the
      // same code sandbox.ts gives a container whose previews are not
      // configured: the port works, the deployment cannot address it, and a
      // retry cannot change that.
      expose: async (port) => {
        const exposed = await (await nimbusProgrammatic()).rpcExposePort(await host(), port);

        if (!exposed.capability) throw new Error(`No process is listening on workspace port ${port}`);
        const answer = await deps.previewUrl(port, exposed.capability);

        if (answer.url === undefined) {
          throw new KinuError('unsupported', `workspace port ${port} is listening and has no preview URL: ${answer.unavailable}`);
        }

        return { ...exposed, url: answer.url };
      },
      unexpose: async (port) => await json((await nimbusProgrammatic()).rpcUnexposePort(await host(), port)),
      list: async () => await Promise.all(
        (await (await nimbusProgrammatic()).rpcListPorts(await host())).map(
          async (entry): Promise<NimbusPortInfo & WorkspacePreviewUrl> => ({
            ...entry, ...await deps.previewUrl(entry.port, entry.capability),
          }),
        ),
      ),
    },
  };
}
