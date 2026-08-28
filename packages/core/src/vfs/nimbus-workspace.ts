/**
 * The embedded Nimbus workspace used by the local CLI.
 *
 * Nimbus (`@nimbus-sh/core`) owns the bytes: a durable POSIX filesystem over a
 * host-supplied SQLite port, with a real shell over it — pipelines, loops,
 * variables, redirection, a working directory that persists across commands,
 * and ~95 coreutils. The host supplies `sql` and `transactions` and nothing
 * else. New hosted workspaces use the remote Nimbus session adapter in
 * execution/nimbus.ts; they do not create these embedded filesystem tables.
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

import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { CRED_KERNEL, CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { SqlDatabase, VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { RuntimePackage } from '@nimbus-sh/core/runtime/runtime-package.js';
import type { HomeRootVfs, TmpConfiner } from './agent-home';
import { provisionWorkspaceRuntimes } from './workspace-runtimes';
import * as v from 'valibot';
import type { VFS, Shell, ShellExecOptions } from '../types/primitives';
import { WORKSPACE_ROOT, workspacePath } from './workspace-path';
import { diagnostics, renderThrownChain, toKinuError } from '../obs/index';

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
  return renderThrownChain({ cause: error }).includes('ENOENT');
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
        if (!st) return;
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
 * It exists only where the filesystem is IN THIS ISOLATE. A host whose
 * workspace is a remote Nimbus session has neither — every pid-less filesystem
 * RPC there is pinned to the session user, and `confinePrincipal` has no RPC at
 * all — so that host provisions nothing and says so.
 */
export interface WorkspacePrivileged {
  /** `SqliteVFS.as(CRED_KERNEL)`. Only uid 0 can `chown` a directory to a uid
   *  that is not its own, which is the whole reason provisioning is host-side. */
  readonly root: HomeRootVfs;
  /** The `SqliteVFS` itself, narrowed to the two principal calls. */
  readonly confiner: TmpConfiner;
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
   * `node:fs` and weigh 40 MB: the deployed Worker has neither, and gets its
   * runtimes from R2 through the hosted session instead. Nothing is written
   * until one of their commands is invoked — see vfs/workspace-runtimes.ts.
   */
  runtimes?: readonly RuntimePackage[];
}

/**
 * Build the workspace filesystem and its shell over a host's SQLite.
 *
 * Returns synchronously over a workspace that is still opening. Booting one is
 * genuinely async — Nimbus sources `/etc/profile` — while runtime construction
 * and the Durable Object constructor behind it are not, and every method of
 * `VFS` and `Shell` already returns a promise. So the boot is started here and
 * awaited inside each call rather than here, which keeps construction
 * synchronous without anyone downstream learning that the filesystem arrives
 * late.
 */
export function createWorkspace(opts: WorkspaceOptions): WorkspaceBundle {
  const booting = NimbusWorkspace.create({
    sql: opts.sql,
    transactions: opts.transactions,
    generation: opts.generation,
    cwd: WORKSPACE_ROOT,
  }).then((workspace) => {
    // Before the first command, and after the substrate's own registrations so
    // a coreutil is never shadowed by a runtime bin of the same name.
    provisionWorkspaceRuntimes({ workspace, runtimes: opts.runtimes ?? [] });
    return workspace;
  });
  // A boot nobody has awaited yet must not surface as an unhandled rejection.
  // The failure still reaches every caller that awaits `booting`; this states it
  // once, because a workspace that fails to boot before any file call is made
  // would otherwise leave no trace at all.
  booting.catch((error) => {
    diagnostics.failure(
      'workspace.boot_failed',
      toKinuError({ doing: 'boot the Nimbus workspace', cause: error, otherwise: 'unavailable' }),
    );
  });
  const open = (): Promise<NimbusWorkspace> => booting;
  // The session's process owner, here because a credentialed shell needs a REAL
  // pid: `ShellCommandIdentity` carries one, append capabilities are keyed by
  // it, and a number invented locally would collide with a live writer. One
  // supervisor for this filesystem, so two agents can never be handed the same
  // pid.
  const processes = new SessionProcessSupervisor();
  const planes = new Map<number, Promise<WorkspaceAgentPlane>>();
  return {
    vfs: workspaceVfs(open),
    shell: workspaceShell(open),
    async stats() { return (await open()).stats(); },
    async privileged() {
      const workspace = await open();
      return { root: workspace.vfs.as(CRED_KERNEL), confiner: workspace.vfs };
    },
    async asAgent(agent) {
      const held = planes.get(agent.cred.uid);
      if (held) return await held;
      const opening = (async (): Promise<WorkspaceAgentPlane> => {
        const origin = await open();
        const process = processes.spawn('agent', [agent.home], agent.home, { cred: agent.cred });
        // A SECOND SHELL over the SAME `SqliteVFS` — never a second filesystem.
        // `vfs` is handed over rather than reopened for exactly that reason: a
        // second instance over one database is a second content cache, and one
        // of the two would serve a stale read. `runAs` is the origin shell's,
        // or this shell loses the identity-transition path `sudo` and `su`
        // dispatch on.
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
        });
        return {
          vfs: agentVfs(origin.vfs.as(agent.cred)),
          shell: workspaceShell(() => Promise.resolve(asAgent)),
        };
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
