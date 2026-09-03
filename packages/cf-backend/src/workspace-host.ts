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
 * The filesystem, the shell, ~95 coreutils, `node`, `npm`, `npx` and `git`. NOT
 * the wasm interpreters (`bash`, `python3`, `ruby`, `clang`): those need a facet
 * substrate that compiles and runs a guest module, which on workerd means the
 * dynamic-worker pool the Nimbus session Durable Object composes for itself, and
 * a workspace held as a library has no such thing. The R2 catalogue binding is
 * retained and `runtimes.*` still reaches it, but `python`/`native_binary` are
 * no longer declared to the model — see `runtimeCatalog` at the call site in
 * runtime.ts.
 */

import * as v from 'valibot';
import { createWorkspace, nextWorkspaceGeneration } from '@kinu.run/core/workspace';
import type { WorkspaceBundle, WorkspaceSession } from '@kinu.run/core/workspace';
import { decodeJsonValue } from '@kinu.run/core';
import type {
  JsonValue,
  NimbusExecResult, NimbusPortInfo, NimbusSandboxHandle, NimbusStartResult,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import {
  nimbusProgrammatic,
  type ProgrammaticHost,
} from './nimbus-programmatic';

/**
 * A read whose only tolerated failure is "there is no such path".
 *
 * ENOENT is how the filesystem reports a missing path, and every SDK-shaped file
 * read answers `null` for exactly that case: `null` is a fact the caller acts on,
 * while a permission failure or a torn chunk is not something to report as
 * absence. Synchronous on purpose — the durable filesystem is, so the throw
 * happens on this stack and nothing has to inspect a rejection.
 */
function absentAsNull<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    if (renderThrownChain({ cause: error }).includes('ENOENT')) return null;
    throw error;
  }
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
      if (options?.recursive) { vfs.removeRecursive(path); return; }
      // A non-recursive delete of a directory is `rmdir`, which refuses a
      // populated one — the same distinction `rm` and `rmdir` draw, kept because
      // the SDK surface has one method for both.
      if (vfs.isDirectory(path)) { vfs.rmdir(path); return; }
      vfs.unlink(path);
    },
  };
}

export interface HostedWorkspaceDeps {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  /**
   * The public URL an exposed port is reachable at, or undefined when this
   * deployment has no preview host or no signing secret. Supplied by the actor
   * because a preview URL names the workspace and is signed with the user-plane
   * secret, neither of which the workspace itself has any business holding.
   */
  previewUrl(port: number, capability: string): string | undefined;
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

/**
 * The marker for a preview URL whose capability is still the persisted one but
 * whose listener did not survive the isolate — the workspace was recycled.
 *
 * Modelled on the container plane's `SDK_STALE_PREVIEW`: a status that is not
 * 404 and a machine-readable body, so a caller can tell "this link never named
 * anything" from "this link names an exposure that an eviction took and only a
 * re-expose can bring back".
 */
const RECYCLED_PREVIEW = {
  status: 410,
  body: JSON.stringify({
    error: 'Preview URL is stale because the workspace was recycled',
    code: 'RECYCLED_WORKSPACE_PREVIEW',
    detail: 'The workspace process that served this port did not survive eviction. '
      + 'Re-expose the port to get a working preview URL.',
  }),
} as const;

/**
 * The durable half of a port's capability, as Nimbus's session layer persists
 * it: `nimbus_preview_capability:<port>` in the object's own KV storage, written
 * at the moment the embedder is handed the URL and retired on every fresh
 * registration.
 *
 * Read here rather than through the worker package because the hosted
 * workspace IS the embedder: the row sits in this object's `ctx.storage` and
 * the value is the same one `ports.expose` answered with. Only the 24-hex
 * minted shape is accepted, exactly as `readPortCapability` itself does.
 */
async function readWorkspacePortCapability(
  ctx: DurableObjectState,
  port: number,
): Promise<string | null> {
  const stored = await ctx.storage.get(`nimbus_preview_capability:${Number(port)}`);
  const parsed = v.safeParse(v.pipe(v.string(), v.regex(/^[a-f0-9]{24}$/)), stored);
  return parsed.success ? parsed.output : null;
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
  });

  // One registry per isolate, exactly as a session has one: a port is a live
  // listener in this isolate's memory, and its capability is persisted through
  // `ctx.storage` by the programmatic surface. What survives an eviction is the
  // DURABLE VALUE ONLY — nothing restarts the workspace's processes on wake
  // (they are waitUntil-held, and `facetManager` is null below), so a URL that
  // outlived its isolate names a port nobody is listening on until the agent
  // re-exposes it. `routePreview` is where that distinction becomes an answer.
  const portRegistry = new PortRegistry();
  let composing: Promise<ProgrammaticHost> | undefined;
  const host = async (): Promise<ProgrammaticHost> => {
    composing ??= (async (): Promise<ProgrammaticHost> => {
      try {
        const session = await bundle.session();
        // `git` over this filesystem: isomorphic-git against the SqliteVFS, with
        // no child process and nothing reaching a host's git. The Durable Object
        // context and env are what the NETWORK subcommands (clone/fetch/pull/push)
        // reach through the git-network facet; local history needs neither, and
        // both are real here.
        const { registerGitCommands } = await nimbusProgrammatic();
        registerGitCommands(session.registry, session.vfs, deps.ctx, deps.env);
        return programmaticHost(session, portRegistry, deps);
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

  const files = workspaceBoxFiles(async () => (await bundle.session()).vfs.as(CRED_SESSION_USER));
  const boxes = new Map<string, NimbusSandboxHandle>();

  return {
    bundle,
    box(shellId) {
      const held = boxes.get(shellId);
      if (held) return held;
      const built = workspaceBox({ host, files, shellId, previewUrl: deps.previewUrl });
      boxes.set(shellId, built);
      return built;
    },
    async routePreview(port, handle, request, pathname) {
      const capability = portRegistry.get(port)?.capability;
      // A port re-exposed under a fresh capability: the link named an exposure
      // that is not this one, in an isolate that still holds one.
      if (capability !== undefined) {
        if (capability.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH) !== handle) {
          return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
        }
      } else {
        // An in-memory miss, answered from the DURABLE copy. Two states share
        // it, and only the persisted value can tell them apart: a URL for a
        // port this isolate never saw is a plain 404, while a URL whose
        // capability is still the persisted one belongs to an exposure an
        // eviction took with the listener that served it — the workspace was
        // recycled, and the agent has to re-expose the port before this link
        // resolves again. A bare 404 would hide that from both the visitor and
        // the operator; this names it.
        const persisted = await readWorkspacePortCapability(deps.ctx, port);
        if (persisted !== null && persisted.slice(0, PREVIEW_CAPABILITY_HANDLE_LENGTH) === handle) {
          return new Response(RECYCLED_PREVIEW.body, {
            status: RECYCLED_PREVIEW.status,
            headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      // Booted only past the miss arm: a stale or unknown link is answered
      // above without composing the workspace.
      const self = await host();
      // An upgrade cannot cross a Durable Object RPC boundary as a 101, which is
      // why Nimbus keeps a fetch route for exactly this case. This method is
      // reached through the orchestrator's own `fetch`, so it can hand one back.
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return await (await nimbusProgrammatic()).routeCapabilityPort(self, port, capability, request, pathname);
      }
      return await (await nimbusProgrammatic()).rpcRouteCapabilityPort(self, port, capability, request, pathname);
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
function programmaticHost(
  session: WorkspaceSession,
  portRegistry: PortRegistry,
  deps: HostedWorkspaceDeps,
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
    // Resident processes and the vite/cirrus dev servers belong to the Nimbus
    // session's dynamic-worker substrate, which a library-held workspace has
    // none of. Absent rather than stubbed: every reader of these is already
    // written for `null`.
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: session.registry,
    _viteShimPid: null,
    _viteShimPort: null,
    ensureSqliteFs: () => undefined,
    ensureFacetManager: () => undefined,
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
  previewUrl(port: number, capability: string): string | undefined;
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
      expose: async (port) => {
        const exposed = await (await nimbusProgrammatic()).rpcExposePort(await host(), port);
        if (!exposed.capability) throw new Error(`No process is listening on workspace port ${port}`);
        const url = deps.previewUrl(port, exposed.capability);
        if (!url) {
          throw new Error(
            'Workspace preview URLs are unavailable because the preview host '
            + 'or user-plane secret is not configured',
          );
        }
        return { ...exposed, url };
      },
      unexpose: async (port) => await json((await nimbusProgrammatic()).rpcUnexposePort(await host(), port)),
      list: async () => (await (await nimbusProgrammatic()).rpcListPorts(await host())).map((entry): NimbusPortInfo & { url?: string } => {
        const url = deps.previewUrl(entry.port, entry.capability);
        return url === undefined ? entry : { ...entry, url };
      }),
    },
  };
}
