/**
 * The Nimbus workspace. There is only this one.
 *
 * Nimbus (`@nimbus-sh/core`) owns the bytes: a durable POSIX filesystem over a
 * host-supplied SQLite port, with a real shell over it — pipelines, loops,
 * variables, redirection, a working directory that persists across commands,
 * and ~95 coreutils. The host supplies `sql` and `transactions` and nothing
 * else — `ctx.storage.sql` and `ctx` in the Durable Object that owns a hosted
 * workspace, a `bun:sqlite` database in the local CLI. ONE workspace per host
 * database and no second Durable Object either way: the filesystem tables sit
 * beside the actor's own rows, so the bytes and the ledgers that index them
 * commit under one `transactionSync` and snapshot as one database.
 *
 * ONE FILESYSTEM, ONE SET OF PATHS
 *
 * `Storage.vfs` and `Shell` here are two views of the same Nimbus filesystem,
 * addressed identically: `vfs.readFile('/etc/passwd')` and `run "cat
 * /etc/passwd"` read the same bytes. Relative paths resolve against
 * {@link WORKSPACE_ROOT}, which is the shell's starting directory and the
 * agent's own home — so `memory/MEMORY.md` means the same file to the `file`
 * tool, to `workspace.readFile`, and to `grep`.
 *
 * There is deliberately no mount table. Other execution environments — the
 * sandbox container, the user's machine, a fork's parent
 * workspace — are EXECUTORS, reached through `run { runtime }` and their
 * codemode namespaces in their own native paths. Presenting them as
 * directories of this filesystem required a router above Nimbus and a second
 * shell that could walk it, which is exactly the split this module removes.
 */

// TYPE-ONLY at module scope. The VALUE loads inside the boot closure: the
// workspace module's static graph carries Nimbus's whole substrate (lifo
// command registry, runtime runners, wasm assets), and evaluating that at
// module eval would put a WebAssembly import into every consumer's collection
// graph — the Worker pays it at cold start and the workerd test pool cannot
// load it at all. The boot is already lazy; the import belongs to it.
import type { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PID_GEN_STRIDE } from '@nimbus-sh/core/runtime/process-table.js';
import type { SqlDatabase, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import type { FacetHost } from '@nimbus-sh/core/runtime/facet-host.js';
import type { FabricComposition } from '@nimbus-sh/fabric/composition.js';
import { agentIdentity, agentTmpRoot, confineAgentTmp, MAIN_AGENT, provisionAgentHome, restoreAgentTmpConfinements, type HomeRootVfs, type TmpConfiner } from './agent-home';
import { provisionWorkspaceRuntimes } from './workspace-runtimes';
import * as v from 'valibot';
import type { VFS, Shell, ShellExecOptions } from '../types/primitives';
import { WORKSPACE_ROOT, workspacePath } from './workspace-path';
import { diagnostics, toKinuError } from '../obs/index';
import { isVfsError, makeVfsError } from './errno';

export { workspaceToolchainCapabilities } from './workspace-runtimes';
export type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';

export { WORKSPACE_ROOT, workspacePath } from './workspace-path';

const ShellExecOptionsSchema: v.GenericSchema<ShellExecOptions | undefined> = v.optional(v.object({
  stdin: v.optional(v.string()),
  signal: v.optional(v.instance(AbortSignal)),
}));

/**
 * The agent's home, the shell's initial working directory, and the base that
 * relative VFS paths resolve against.
 *
 * It is a real directory of a real filesystem rather than a synthetic root:
 * `/etc`, `/usr` and `/tmp` are reachable at their own names, and the agent's
 * durable work lives where a user's work lives. Surfaces that mean "the
 * agent's own files" (archive, backup, the file browser) walk this path;
 * nothing rewrites addresses to fake it.
 */
/** ENOENT is how Nimbus reports a missing path; the core VFS contract stats it
 *  as `null` and answers `exists` with `false`. */
function isEnoent({ error }: { error: unknown }): boolean {
  if (isVfsError(error)) return error.code === 'ENOENT';
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
  return false;
}

function shellExecOptions(input: { value: unknown }): ShellExecOptions | undefined {
  const stdin = v.safeParse(v.string(), input.value);
  if (stdin.success) return { stdin: stdin.output };
  const options = v.safeParse(ShellExecOptionsSchema, input.value);
  return options.success ? options.output : undefined;
}

/**
 * `Storage.vfs`, plus the two operations the file surfaces need that the seven
 * do not cover. Both are native here: Nimbus removes a tree in one bounded
 * statement and renames without reading the bytes, so `rm -r` and `mv` of a
 * directory are ordinary operations rather than the refusals a filesystem
 * without directory entries has to make.
 */
export interface WorkspaceVFS extends VFS {
  removeRecursive(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Exactly this window of one file's bytes, read out of the chunk rows that
   *  cover it. A caller that must not hold a whole file — the fork wire — reads
   *  through this rather than `readFile`. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
}

function workspaceVfs(open: () => Promise<NimbusWorkspace>): WorkspaceVFS {
  const fs = async (): Promise<NimbusWorkspace['fs']> => (await open()).fs;
  const self: WorkspaceVFS = {
    async readFile(path, opts) {
      const abs = workspacePath(path);
      return opts?.encoding === 'utf8' ? (await fs()).readFile(abs) : (await fs()).readFile(abs, null);
    },
    async writeFile(path, data) { await (await fs()).writeFile(workspacePath(path), data); },
    async readdir(path) { return (await (await fs()).readdir(workspacePath(path))).map((entry) => entry.name); },
    async stat(path) {
      try {
        const st = await (await fs()).stat(workspacePath(path));
        return { size: st.size, mtimeMs: st.mtime, isDir: st.type === 'directory' };
      } catch (err) {
        if (isEnoent({ error: err })) return null;
        throw err;
      }
    },
    async unlink(path) { await (await fs()).rm(workspacePath(path)); },
    async mkdir(path, opts) { await (await fs()).mkdir(workspacePath(path), opts); },
    async exists(path) { return (await fs()).exists(workspacePath(path)); },

    /**
     * Depth-first, rather than `SandboxFs.rm(..., { recursive: true })`.
     *
     * That one resolves the tree it is about to delete through the kernel's own
     * in-memory nodes (@nimbus-sh/core kernel/vfs/VFS.ts `resolveNode`), which
     * do not cover a provider-backed mount — so it raises ENOENT on a directory
     * that demonstrably exists. Removing the entries one at a time goes through
     * the mount provider, which handles both an unlink and an empty-directory
     * removal correctly.
     */
    async removeRecursive(path) {
      const handle = await fs();
      const remove = async (target: string): Promise<void> => {
        const st = await self.stat(target);
        if (!st) throw makeVfsError('ENOENT', 'no such file or directory', target);
        if (st.isDir) {
          for (const name of await self.readdir(target)) await remove(`${target}/${name}`);
        }
        await handle.rm(workspacePath(target));
      };
      await remove(path);
    },

    async rename(oldPath, newPath) {
      await (await fs()).rename(workspacePath(oldPath), workspacePath(newPath));
    },

    async readRange(path, offset, length) {
      return (await open()).vfs.as(CRED_SESSION_USER).readRange(workspacePath(path), offset, length);
    },
  };
  return self;
}

/**
 * The Nimbus shell as a Kinu `Shell`.
 *
 * No `cwd` is passed per command on purpose: the shell owns its own working
 * directory, so `cd` persists across calls the way it does in a terminal.
 */
function workspaceShell(open: () => Promise<NimbusWorkspace>): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options = shellExecOptions({ value: stdinOrOptions });
      const result = await (await open()).exec(command, {
        stdin: options?.stdin,
        signal: options?.signal,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}

/**
 * The same filesystem as ONE AGENT: the same rows, reached with the agent's own
 * credential on both planes.
 *
 * Two members and not one, because an agent reaches the tree two ways and a
 * boundary that held for only one is not a boundary. Its file tools go through
 * {@link vfs}; its commands go through {@link shell}, which starts in the
 * agent's home with `HOME` and `TMPDIR` already pointing at the agent's own
 * directories.
 */
export interface WorkspaceAgentPlane {
  readonly vfs: WorkspaceVFS;
  readonly shell: Shell;
}

/** Who the agent is, and where its own directories are — as
 *  `vfs/agent-home.ts` provisioned them. */
export interface WorkspaceAgent {
  readonly cred: VfsCred;
  readonly home: string;
  readonly tmp: string;
}

/**
 * The agent's file plane: the SAME `SqliteVFS`, credentialed.
 *
 * Not the workspace's own `.fs`, which is pinned to the session user by
 * construction (`NimbusWorkspace`'s constructor) — that identity is the ORIGIN
 * and it is exactly what must not be reused here. The sync surface is adapted
 * rather than wrapped in another cache: one filesystem instance, one set of
 * rows, one content cache.
 */
function agentVfs(vfs: CredentialedVfs): WorkspaceVFS {
  const self: WorkspaceVFS = {
    async readFile(path, opts) {
      const absolute = workspacePath(path);
      return opts?.encoding === 'utf8' ? vfs.readFileString(absolute) : vfs.readFile(absolute);
    },
    async writeFile(path, data) { vfs.writeFile(workspacePath(path), data); },
    async readdir(path) { return vfs.readdir(workspacePath(path)).map((entry) => entry.name); },
    async stat(path) {
      try {
        const stat = vfs.stat(workspacePath(path));
        return { size: stat.size, mtimeMs: stat.mtime, isDir: stat.type === 'directory' };
      } catch (error) {
        if (isEnoent({ error })) return null;
        throw error;
      }
    },
    async unlink(path) { vfs.unlink(workspacePath(path)); },
    async mkdir(path, opts) { vfs.mkdir(workspacePath(path), opts); },
    async exists(path) { return vfs.exists(workspacePath(path)); },
    async removeRecursive(path) { vfs.removeRecursive(workspacePath(path)); },
    async rename(oldPath, newPath) { vfs.rename(workspacePath(oldPath), workspacePath(newPath)); },
    async readRange(path, offset, length) { return vfs.readRange(workspacePath(path), offset, length); },
  };
  return self;
}

/**
 * The privileged half of this filesystem: a uid-0 view of the same bytes, and
 * the principal registry that scopes `/tmp` per uid.
 *
 * Present wherever this filesystem is, which is wherever a workspace is: it is
 * built from the host's own SQLite, so uid 0 is reachable and `confinePrincipal`
 * is an ordinary method call rather than an RPC nobody exposes.
 */
export interface WorkspacePrivileged {
  /** `SqliteVFS.as(CRED_KERNEL)`. Only uid 0 can `chown` a directory to a uid
   *  that is not its own, which is the whole reason provisioning is host-side. */
  readonly root: HomeRootVfs;
  /** The `SqliteVFS` itself, narrowed to the two principal calls. */
  readonly confiner: TmpConfiner;
}

/**
 * What the workspace's dispatch answers. A host forwards it to the supervisor
 * entrypoint without looking inside: the entrypoint's own typed methods
 * narrow each answer, and this follows the library's declaration so a
 * narrower answer upstream narrows every host for free.
 */
export type SupervisorOpResult = Awaited<ReturnType<NimbusWorkspace['supervisorOp']>>;

/**
 * This workspace's own Nimbus primitives, as a host's process/port surface
 * binds to them.
 *
 * Five members and no more: the shell commands actually run on, the raw
 * credentialed filesystem, the registry a host adds `git` to, the process
 * owner whose pids this filesystem's append capabilities are keyed by, and
 * the one dispatch a facet reaches its host through. Anything a host can
 * compose from those is the host's, not this module's.
 */
export interface WorkspaceSession {
  readonly shell: NimbusWorkspace['shell'];
  readonly vfs: SqliteVFS;
  readonly registry: NimbusWorkspace['registry'];
  /** The ONE process owner of this filesystem. A host that spawns through its
   *  own would hand out pids at or below the revoked generation floor. */
  readonly processes: SessionProcessSupervisor;
  /**
   * The one method a workspace host mounts for its facets.
   *
   * Every filesystem call a dynamic worker makes arrives here, credentialed
   * to the process whose command started the work. A Durable Object that
   * hosts this workspace forwards its own mounted method to this one — that
   * forwarding is the whole host obligation, and without it `git clone` and
   * `npm install` refuse before they spawn anything.
   */
  readonly supervisorOp: (envelope: SupervisorOpEnvelope) => Promise<SupervisorOpResult>;
}

export interface WorkspaceBundle {
  /** `Storage.vfs` — the workspace filesystem. */
  vfs: WorkspaceVFS;
  /** The shell over those same bytes. */
  shell: Shell;
  /** Files, directories and bytes this workspace occupies. */
  stats(): Promise<{ files: number; dirs: number; usedBytes: number }>;
  /**
   * The uid-0 view and the principal registry, for provisioning a per-agent
   * home.
   *
   * A promise for the same reason every other member of this bundle returns
   * one: the workspace boots late. Resolving it eagerly at construction would
   * serialise a host's whole startup on a boot nothing has asked for yet.
   */
  privileged(): Promise<WorkspacePrivileged>;
  /**
   * The same filesystem as one provisioned agent, on both planes.
   *
   * One plane per agent and cached by uid, because a shell HOLDS state — a
   * working directory, exported variables — so an agent that got a fresh shell
   * per command would lose its own `cd`. Idempotent for that reason too: the
   * second call for a uid is the first plane again.
   */
  asAgent(agent: WorkspaceAgent): Promise<WorkspaceAgentPlane>;
  /**
   * The composed Nimbus primitives, for a host that has to build a surface
   * this bundle deliberately does not: background processes, listening ports,
   * an R2 runtime catalogue.
   *
   * Those belong to the HOST — a Durable Object holds `ctx.waitUntil` and a
   * port registry a `bun` process has no use for — so they are composed over
   * these three rather than reimplemented here. Handing over the workspace's
   * OWN shell, filesystem and registry is the whole point: a host that opened
   * its own would have a second content cache over one database, and a host
   * that spawned from its own process table would issue pids this filesystem
   * has already revoked.
   */
  session(): Promise<WorkspaceSession>;
  /** Observe file changes after boot, including a successful retry. */
  onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
  /**
   * Drop this workspace's tables, leaving the host's own rows alone.
   *
   * The deletion of a workspace, which on a shared database cannot be
   * `deleteAll`: the actor's conversation, ledgers and identity live in the
   * same SQLite and are dropped by the actor's own teardown.
   */
  destroy(): Promise<void>;
}

export interface WorkspaceOptions {
  /** The host's SQLite. In a Durable Object: `ctx.storage.sql`. */
  sql: SqlDatabase;
  /** Carries `transactionSync`. In a Durable Object: `ctx`. Every atomic write
   *  in the filesystem rests on this being a real transaction. */
  transactions: { readonly storage?: { transactionSync<T>(cb: () => T): T } };
  /**
   * Process-id generation, which must never repeat for a given database: the
   * workspace revokes every append capability at or below `generation *
   * 1_000_000` before serving anything, so a repeating value hands a dead
   * process live write authority. Use {@link nextWorkspaceGeneration}.
   */
  generation: number;
  /**
   * Language runtimes this host can install into the workspace, as the npm
   * packages that hold them (`@nimbus-sh/runtime-bash`,
   * `@nimbus-sh/runtime-cpython`).
   *
   * Supplied by the host rather than imported here because the packages read
   * `node:fs` and weigh 40 MB: the deployed Worker has neither. Nothing is
   * written until one of their commands is invoked — see
   * vfs/workspace-runtimes.ts.
   */
  runtimes?: readonly RuntimePackage[];
  /**
   * Where a wasm interpreter runs. Absent on workerd, where nothing can:
   * see `provisionWorkspaceRuntimes`' own `facets`, which this is.
   */
  runtimeFacets?: FacetHost;
  /**
   * The embedder's fabric composition, for a host that can run dynamic
   * workers. A Durable Object host passes its supervisor entrypoint, its own
   * namespace binding and the method it mounts; the local CLI passes nothing
   * and keeps the filesystem, the shell and the coreutils with no facet
   * substrate to reach.
   */
  fabric?: FabricComposition;
}

/**
 * Build the workspace filesystem and its shell over a host's SQLite.
 * Returns synchronously over a workspace that opens on its first operation.
 * Booting one is genuinely async — Nimbus sources `/etc/profile` — while
 * runtime construction and the Durable Object constructor behind it are not,
 * and every method of `VFS` and `Shell` already returns a promise. Opening
 * lazily means an unused bundle never starts unowned work; the first operation
 * owns and awaits the boot without anyone downstream learning that the
 * filesystem arrives late.
 */
export function createWorkspace(opts: WorkspaceOptions): WorkspaceBundle {
  const fileListeners = new Set<(paths: readonly string[]) => void>();
  let booting: Promise<NimbusWorkspace> | undefined;
  const open = async (): Promise<NimbusWorkspace> => {
    if (!booting) {
      booting = (async (): Promise<NimbusWorkspace> => {
        try {
          const { NimbusWorkspace } = await import('@nimbus-sh/core/workspace');
          const workspace = await NimbusWorkspace.create({
            sql: opts.sql,
            transactions: opts.transactions,
            generation: opts.generation,
            cwd: WORKSPACE_ROOT,
            env: { HOME: WORKSPACE_ROOT, TMPDIR: agentTmpRoot(MAIN_AGENT) },
            // The embedder's fabric, stated once per isolate. A workspace
            // whose host can run dynamic workers reaches them through this:
            // the fabric mints every facet's `env.SUPERVISOR` binding from
            // the composed entrypoint, and `ctx.exports` is adopted off
            // `transactions` (in a Durable Object that IS `ctx`). Absent —
            // the local CLI passes none — the workspace stays the
            // filesystem, the shell and the coreutils, and anything needing
            // a dynamic worker refuses before it spawns. First-write-wins
            // per isolate, so passing it on every create is idempotent.
            fabric: opts.fabric,
          });
          // Before the first command, and after the substrate's own
          // registrations so a coreutil is never shadowed by a runtime bin of
          // the same name.
          const provisioning: Parameters<typeof provisionWorkspaceRuntimes>[0] = {
            workspace,
            runtimes: opts.runtimes ?? [],
          };
          if (opts.runtimeFacets !== undefined) provisioning.facets = opts.runtimeFacets;
          await provisionWorkspaceRuntimes(provisioning);
          const root = workspace.vfs.as(CRED_KERNEL);
          const main = agentIdentity(opts.sql, MAIN_AGENT);
          provisionAgentHome(root, MAIN_AGENT, main);
          confineAgentTmp(workspace.vfs, MAIN_AGENT, main);
          // Rebuild each live facet's temporary-path mapping after a reset.
          restoreAgentTmpConfinements(opts.sql, root, workspace.vfs);
          workspace.vfs.events.on((batch) => {
            if (fileListeners.size === 0) return;
            const paths = batch.map((event) => event.path);
            for (const listener of fileListeners) listener(paths);
          });
          return workspace;
        } catch (cause) {
          // Clear the cache BEFORE rethrowing: this bundle lives for the whole
          // actor isolate, and a cached rejection is poison with no expiry —
          // every later read, exec, fork frame and archive walk re-awaits the
          // same failure, and each user retry resets the eviction timer, so
          // the retry defeats the only recovery path there was. A
          // deterministic failure simply re-fails on the next open, which is
          // the correct answer; a transient one gets its retry.
          booting = undefined;
          diagnostics.failure(
            'workspace.boot_failed',
            toKinuError({ doing: 'boot the Nimbus workspace', cause, otherwise: 'unavailable' }),
          );
          throw cause;
        }
      })();
    }
    return await booting;
  };
  // The workspace's process owner, here because a credentialed shell needs a
  // REAL pid: `ShellCommandIdentity` carries one, append capabilities are keyed
  // by it, and a number invented locally would collide with a live writer. One
  // supervisor for this filesystem, so two agents — or an agent and a host's
  // background process — can never be handed the same pid.
  //
  // The pid base is THIS generation's floor. Opening the filesystem revokes
  // every append writer at or below `generation * PID_GEN_STRIDE`, so a
  // supervisor left at zero hands out pids whose write authority the very next
  // boot has already withdrawn.
  const processes = new SessionProcessSupervisor();
  processes.setPidBase(opts.generation * PID_GEN_STRIDE);
  const planes = new Map<number, Promise<WorkspaceAgentPlane>>();
  return {
    vfs: workspaceVfs(open),
    shell: workspaceShell(open),
    onFilesChanged(listener) {
      fileListeners.add(listener);
      return () => { fileListeners.delete(listener); };
    },
    async stats() { return (await open()).stats(); },
    async privileged() {
      const workspace = await open();
      return { root: workspace.vfs.as(CRED_KERNEL), confiner: workspace.vfs };
    },
    async session() {
      const workspace = await open();
      return {
        shell: workspace.shell,
        vfs: workspace.vfs,
        registry: workspace.registry,
        processes,
        // Bound to the origin workspace: the dispatch table is built over
        // its filesystem at create, and a facet's writes must land there
        // rather than in an agent plane's shell-only second compose.
        supervisorOp: (envelope: SupervisorOpEnvelope) => workspace.supervisorOp(envelope),
      };
    },
    async destroy() { (await open()).destroy(); },
    async asAgent(agent) {
      const held = planes.get(agent.cred.uid);
      if (held) return await held;
      const opening = (async (): Promise<WorkspaceAgentPlane> => {
        try {
          const origin = await open();
          const process = processes.spawn('agent', [agent.home], agent.home, { cred: agent.cred });
          // A SECOND SHELL over the SAME `SqliteVFS` — never a second filesystem.
          // `vfs` is handed over rather than reopened for exactly that reason: a
          // second instance over one database is a second content cache, and one
          // of the two would serve a stale read. `runAs` is the origin shell's,
          // or this shell loses the identity-transition path `sudo` and `su`
          // dispatch on.
          const { NimbusWorkspace } = await import('@nimbus-sh/core/workspace');
          const asAgent = await NimbusWorkspace.create({
            sql: opts.sql,
            transactions: opts.transactions,
            vfs: origin.vfs,
            cwd: agent.home,
            env: { HOME: agent.home, TMPDIR: agent.tmp },
            identity: {
              pid: process.pid,
              cred: processes.cred(process.pid),
              setUmask: (mask: number) => { processes.setUmask(process.pid, mask); },
              runAs: origin.shell.getRunAsHost(),
            },
            // The origin create already stated it; this re-states nothing new.
            fabric: opts.fabric,
          });
          return {
            vfs: agentVfs(origin.vfs.as(agent.cred)),
            shell: workspaceShell(() => Promise.resolve(asAgent)),
          };
        } catch (cause) {
          // Same rule as `booting`: a cached rejection would pin this agent's
          // plane to one transient failure for the life of the isolate.
          planes.delete(agent.cred.uid);
          throw cause;
        }
      })();
      planes.set(agent.cred.uid, opening);
      return await opening;
    },
  };
}

const GENERATION_TABLE = 'kinu_workspace_generation';

/**
 * The next never-repeating process generation for this database.
 *
 * Durable because it is a row, not a field — a Durable Object that is evicted
 * and re-created must not restart the count.
 */
export function nextWorkspaceGeneration(sql: SqlDatabase): number {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${GENERATION_TABLE} (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`);
  sql.exec(
    `INSERT INTO ${GENERATION_TABLE} (id, value) VALUES (1, 1)
     ON CONFLICT(id) DO UPDATE SET value = value + 1`,
  );
  const [row] = [...sql.exec(`SELECT value FROM ${GENERATION_TABLE} WHERE id = 1`)];
  return Number(row?.value ?? 1);
}
