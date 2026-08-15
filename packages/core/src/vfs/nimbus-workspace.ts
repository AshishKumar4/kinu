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
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import * as v from 'valibot';
import type { VFS, Shell, ShellExecOptions } from '../types/primitives.js';
import { WORKSPACE_ROOT, workspacePath } from './workspace-path.js';

export { WORKSPACE_ROOT, workspacePath } from './workspace-path.js';

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
  return error instanceof Error && error.message.startsWith('ENOENT');
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
  };
  return self;
}

/**
 * The Nimbus shell as a Proteus `Shell`.
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

export interface WorkspaceBundle {
  /** `Storage.vfs` — the workspace filesystem. */
  vfs: WorkspaceVFS;
  /** The shell over those same bytes. */
  shell: Shell;
  /** Files, directories and bytes this workspace occupies. */
  stats(): Promise<{ files: number; dirs: number; usedBytes: number }>;
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
  });
  // A boot nobody has awaited yet must not surface as an unhandled rejection;
  // the failure is still delivered to every caller that awaits `booting`.
  booting.catch(() => {});
  const open = (): Promise<NimbusWorkspace> => booting;
  return {
    vfs: workspaceVfs(open),
    shell: workspaceShell(open),
    async stats() { return (await open()).stats(); },
  };
}

const GENERATION_TABLE = 'proteus_workspace_generation';

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
