/**
 * The workspace's durable filesystem and shell, powered by Nimbus.
 *
 * `/local` — the workspace's durable base — is a real filesystem with a real
 * shell rather than the 17-command emulator it used to be: pipelines, loops,
 * variables, arithmetic, redirection, `cd`, and ~95 coreutils, all over the
 * OrchestratorAgent's OWN SQLite. No second Durable Object is involved; the
 * workspace is a component this DO holds, which is exactly what
 * `NimbusWorkspace` is built to be (it owns no transport and no session).
 *
 * WHY THE COMPOSITE STAYS ON TOP
 *
 * Nimbus can hold `/local` and nothing else. Its mount seam, `MountProvider`
 * (@nimbus-sh/core kernel/vfs/types.ts:118), is fully SYNCHRONOUS —
 * `writeFile(...): void`. Every other Proteus mount is an async round trip:
 * `/parent` is Durable Object RPC, `/sandbox` a container handle, `/pc` a
 * WebSocket device tunnel (see core/src/vfs/mount-adapters.ts). A synchronous
 * provider cannot await a network hop, so those mounts can never live inside
 * Nimbus's kernel. CompositeVFS therefore remains the router for the file
 * plane, and Nimbus becomes the thing sitting under its `local` row — one set
 * of bytes, addressed identically by the shell and by the `file` tool.
 */

import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { Shell, ShellExecOptions, VFS } from '@proteus/core';

/**
 * `/local` as the composite holds it: the seven VFS methods plus the two the
 * composite prefers a mount's own implementation of. Nimbus does both
 * natively, so `rm -r` and `mv` of a directory stop being the plane-level
 * refusals they were on SqliteFS.
 */
type LocalVfs = VFS & {
  removeRecursive(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
};

/**
 * Where `/local`'s paths live inside the Nimbus filesystem.
 *
 * The composite hands this mount environment-native paths with its leading
 * slash already stripped (`rootPath: ''` — see CompositeVFS.envPath), so
 * `/local/src/main.ts` arrives as `src/main.ts`. It lands under the session
 * user's home because that is the directory Nimbus boots its shell into and
 * the one the user owns; rooting `/local` at `/` instead would put the
 * agent's own files beside `/etc` and `/usr` and make `ls /local` a tour of
 * the OS rather than a listing of its work.
 */
const LOCAL_ROOT = '/home/user';

/** Composite-relative path → absolute Nimbus path. */
function nimbusPath(path: string): string {
  const clean = path.replace(/^\/+/, '');
  return clean === '' ? LOCAL_ROOT : `${LOCAL_ROOT}/${clean}`;
}

/** ENOENT is how Nimbus reports a missing path; the core VFS contract stats
 *  it as `null` and answers `exists` with `false`. */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && /^ENOENT/.test(err.message);
}

/**
 * The core VFS over the Nimbus filesystem, for CompositeVFS's `local` row.
 *
 * `removeRecursive` and `rename` are beyond the seven the interface requires;
 * the composite prefers a mount's own when it has one, and Nimbus does both
 * natively — so `rm -r` and `mv` of a directory stop being the plane-level
 * refusals they are on SqliteFS.
 */
function nimbusVfs(open: () => Promise<NimbusWorkspace>): LocalVfs {
  const fs = async (): Promise<NimbusWorkspace['fs']> => (await open()).fs;
  return {
    async readFile(path, opts) {
      const abs = nimbusPath(path);
      return opts?.encoding === 'utf8' ? (await fs()).readFile(abs) : (await fs()).readFile(abs, null);
    },
    async writeFile(path, data) { await (await fs()).writeFile(nimbusPath(path), data); },
    async readdir(path) { return (await (await fs()).readdir(nimbusPath(path))).map((entry) => entry.name); },
    async stat(path) {
      try {
        const st = await (await fs()).stat(nimbusPath(path));
        return { size: st.size, mtimeMs: st.mtime, isDir: st.type === 'directory' };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async unlink(path) { await (await fs()).rm(nimbusPath(path)); },
    async mkdir(path, opts) { await (await fs()).mkdir(nimbusPath(path), opts); },
    async exists(path) { return (await fs()).exists(nimbusPath(path)); },
    /**
     * Depth-first, rather than `SandboxFs.rm(..., { recursive: true })`.
     *
     * That one resolves the tree it is about to delete through the kernel's
     * own in-memory nodes (@nimbus-sh/core kernel/vfs/VFS.ts:752 →
     * `resolveNode`, VFS.ts:215), which do not cover a provider-backed mount —
     * so it raises ENOENT on a directory that demonstrably exists. Removing
     * the entries one at a time goes through the mount provider, which handles
     * both an unlink and an empty-directory removal correctly.
     */
    async removeRecursive(path) {
      const handle = await fs();
      const remove = async (target: string): Promise<void> => {
        const st = await this.stat(target);
        if (!st) return;
        if (st.isDir) {
          for (const name of await this.readdir(target)) await remove(`${target}/${name}`);
        }
        await handle.rm(nimbusPath(target));
      };
      await remove(path.replace(/^\/+/, ''));
    },
    async rename(oldPath, newPath) { await (await fs()).rename(nimbusPath(oldPath), nimbusPath(newPath)); },
  };
}

/**
 * The Nimbus shell as a Proteus `Shell`.
 *
 * No `cwd` is passed per command on purpose: the Nimbus shell owns its own
 * working directory, so `cd` finally persists across calls instead of being
 * refused by a stateless emulator.
 */
function nimbusShell(open: () => Promise<NimbusWorkspace>): Shell {
  return {
    async exec(command, stdinOrOptions) {
      const options: ShellExecOptions | undefined =
        typeof stdinOrOptions === 'string' ? { stdin: stdinOrOptions } : stdinOrOptions;
      const result = await (await open()).exec(command, {
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}

export interface NimbusWorkspaceBundle {
  /** CompositeVFS's `local` row — the durable base. */
  vfs: VFS;
  /** The workspace shell over that base. */
  shell: Shell;
}

/**
 * Build the durable base and its shell over a host's SQLite.
 *
 * Returns synchronously over a workspace that is still opening. Booting one
 * is genuinely async — Nimbus sources `/etc/profile` — while `createCFRuntime`
 * and the Durable Object constructor behind it are not, and every method of
 * `VFS` and `Shell` already returns a promise. So the boot is started here and
 * awaited inside each call instead of being awaited here, which keeps the
 * runtime's construction synchronous without anyone downstream learning that
 * the filesystem arrives late.
 *
 * `generation` must never repeat for a given database: the workspace revokes
 * every append capability at or below `generation * 1_000_000` before serving
 * anything, so a repeating value hands a dead process live write authority.
 */
export function createNimbusWorkspace(opts: {
  sql: SqlDatabase;
  transactions: { readonly storage?: { transactionSync<T>(cb: () => T): T } };
  generation: number;
  /**
   * A pre-Nimbus `/local` to copy in before the workspace serves anything.
   *
   * Part of the boot rather than a job alongside it: a copy running next to
   * live reads would let the first turn of an upgraded agent see a filesystem
   * that is still filling up, which reads exactly like missing files.
   */
  migrateFrom?: VFS;
}): NimbusWorkspaceBundle {
  ensureWorkspaceTables(opts.sql);
  const booting = (async (): Promise<NimbusWorkspace> => {
    const ws = await NimbusWorkspace.create({
      sql: opts.sql,
      transactions: opts.transactions,
      generation: opts.generation,
      cwd: LOCAL_ROOT,
    });
    if (opts.migrateFrom) {
      await migrateLegacyLocalFiles(opts.sql, opts.migrateFrom, nimbusVfs(async () => ws));
    }
    return ws;
  })();
  // A boot nobody has awaited yet must not surface as an unhandled rejection;
  // the failure is still delivered to every caller that awaits `booting`.
  booting.catch(() => {});
  const open = (): Promise<NimbusWorkspace> => booting;
  return { vfs: nimbusVfs(open), shell: nimbusShell(open) };
}

/**
 * The workspace shell: Nimbus for the durable base, the composite shell for
 * anything that reaches across mounts.
 *
 * Nimbus holds `/local` alone (see the header — its mount seam is
 * synchronous and every other mount is an async round trip), so a command
 * naming `/pc`, `/sandbox`, `/nimbus` or `/parent` has to run on the one
 * plane that can reach them. That is the existing composite shell, reused
 * verbatim: no command is implemented twice, and the two planes share the
 * `/local` BYTES, so a file written through one is read by the other.
 *
 * The test is textual — the mount prefixes the command mentions — because a
 * shell cannot know which paths a command will touch without running it. It
 * is deliberately biased toward the composite: a command mentioning a mount
 * runs where every mount is reachable, and only commands that mention none
 * take the Nimbus path. The residual imprecision is a command that reaches a
 * mount without naming it (through a variable, say), which lands on Nimbus
 * and reports the path as missing.
 */
export function createWorkspaceShell(opts: {
  /** Nimbus, over the durable base. */
  base: Shell;
  /** The emulated shell over the whole CompositeVFS mount table. */
  crossMount: Shell;
  /** Live non-local mount names, e.g. `['sandbox', 'pc']`. */
  mountNames: () => readonly string[];
}): Shell {
  return {
    exec(command, stdinOrOptions) {
      const names = opts.mountNames().filter((name) => name !== 'local');
      const reachesMount =
        names.length > 0 &&
        new RegExp(`/(?:${names.join('|')})(?:/|\\b)`).test(command);
      return (reachesMount ? opts.crossMount : opts.base).exec(command, stdinOrOptions);
    },
  };
}

/**
 * The next never-repeating process generation for this database.
 *
 * Nimbus revokes every append capability at or below `generation * 1_000_000`
 * before serving anything, so this must advance on every boot: a value that
 * repeats would leave a previous boot's dead writers holding live authority
 * over the filesystem. Durable because it is a row, not a field — a Durable
 * Object that is evicted and re-created must not restart the count.
 */
export function nextWorkspaceGeneration(sql: SqlDatabase): number {
  ensureWorkspaceTables(sql);
  sql.exec(
    `INSERT INTO ${GENERATION_TABLE} (id, value) VALUES (1, 1)
     ON CONFLICT(id) DO UPDATE SET value = value + 1`,
  );
  const [row] = [...sql.exec(`SELECT value FROM ${GENERATION_TABLE} WHERE id = 1`)];
  return Number(row?.value ?? 1);
}

const GENERATION_TABLE = 'proteus_workspace_generation';

/**
 * The workspace's own bookkeeping tables, created together and synchronously.
 *
 * Both are boot-time facts rather than products of the async filesystem boot,
 * so they exist from the moment the runtime is built — which is also what lets
 * the conformance manifest see them at every root that has them.
 */
function ensureWorkspaceTables(sql: SqlDatabase): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${GENERATION_TABLE} (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (done INTEGER PRIMARY KEY)`);
}

/** Marks the one-time copy of a pre-Nimbus `/local` so it happens once. */
const MIGRATION_TABLE = 'proteus_local_nimbus_migration';

/**
 * Copy a pre-Nimbus `/local` into the Nimbus filesystem, once.
 *
 * Agents created before this change hold their durable base in SqliteFS's
 * `vfs_files`; Nimbus keeps its own tables, so without this their scaffold,
 * source and notes would simply be absent the next time they booted. The two
 * schemas do not collide, so the old rows stay where they are and this is a
 * copy rather than a move — a boot that fails halfway re-runs cleanly, and
 * the original is still there if it needs to.
 */
export async function migrateLegacyLocalFiles(
  sql: SqlDatabase,
  legacy: VFS,
  target: VFS,
): Promise<{ migrated: number } | null> {
  if ([...sql.exec(`SELECT done FROM ${MIGRATION_TABLE} LIMIT 1`)].length > 0) return null;

  let migrated = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await legacy.readdir(dir)) {
      const path = dir === '' ? name : `${dir}/${name}`;
      const st = await legacy.stat(path);
      if (!st) continue;
      if (st.isDir) {
        await target.mkdir(path, { recursive: true });
        await walk(path);
        continue;
      }
      await target.writeFile(path, await legacy.readFile(path));
      migrated++;
    }
  };
  await walk('');

  sql.exec(`INSERT INTO ${MIGRATION_TABLE} (done) VALUES (1)`);
  return { migrated };
}
