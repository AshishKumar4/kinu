/**
 * VirtualSandbox — always-on baseline sandbox backed by the agent's own SQLite VFS.
 *
 * Wraps the existing agent-utils `VFS` (SqliteFS) + `createShell` virtual-bash
 * dispatcher (16 POSIX commands: cat, grep, find, sed, ls, tree, head, tail,
 * wc, mkdir, rm, cp, mv, echo, sort, uniq, xargs — see agent-utils/shell/).
 *
 * Use cases:
 *   • Always-available file workspace for any agent (even with no other
 *     sandboxes registered)
 *   • Memory + scaffold + crafted-tool storage backplane
 *   • Cheap exec for shell-side string manipulation (grep, sed, find) without
 *     paying container cold-start
 *
 * What it CANNOT do:
 *   • Spawn real processes (node, npm, git) — the virtual shell rejects them
 *     with a clear "use sandbox_exec" message
 *   • Net IO
 *   • Native binaries
 *
 * Capabilities: `shell` (virtual), `fs_persistent`, `fs_shared`.
 */

import type { SandboxApi, SandboxCapability, DirEntry, Stat, ShellResult, ExecOptions } from '../types.js';
import { SandboxError } from '../types.js';

/**
 * Minimal VFS shape this sandbox needs.
 *
 * Matches the agent-utils `VFS` interface (vfs/types.ts) and the core
 * `VFS` primitive (types/primitives.ts) — we accept both via structural typing.
 * Storage isolation lives at the VFS layer; this wrapper is pure adapter.
 */
export interface VirtualVFS {
  readFile(path: string, options?: { encoding?: 'utf8' }): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number }>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean } | unknown): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Optional: present on agent-utils SqliteFS; used for recursive rm. */
  removeRecursive?(path: string): Promise<void>;
  rmdir?(path: string): Promise<void>;
}

/** Minimal shell shape — matches createShell(vfs) return value. */
export interface VirtualShell {
  exec(input: string, stdin?: string): Promise<ShellResult>;
}

export interface VirtualSandboxDeps {
  /** Stable identifier used in PortInfo URLs (not applicable here, but for telemetry). */
  id: string;
  vfs: VirtualVFS;
  shell: VirtualShell;
}

function joinPath(cwd: string, p: string): string {
  // Treat absolute paths as-is. Otherwise join with cwd, normalising '..' and '.'.
  if (p.startsWith('/')) return normalize(p);
  return normalize(cwd.replace(/\/$/, '') + '/' + p);
}

function normalize(p: string): string {
  const parts = p.split('/').filter((s) => s.length > 0 && s !== '.');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

export function createVirtualSandbox(deps: VirtualSandboxDeps): SandboxApi {
  const { id, vfs, shell } = deps;

  const capabilities = new Set<SandboxCapability>(['shell', 'fs_persistent', 'fs_shared']);

  async function safeStat(path: string): Promise<Stat | null> {
    try {
      const s = await vfs.stat(path);
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'dir',
        isSymbolicLink: false,
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  return {
    id,
    kind: 'virtual',
    capabilities,

    async connect() { /* always connected */ },
    async disconnect() { /* nothing to release */ },
    isAvailable: () => true,

    async exec(command: string, options?: ExecOptions): Promise<ShellResult> {
      const t0 = Date.now();
      try {
        // The virtual shell is stateless and doesn't know about cwd —
        // prepend a `cd` simulation by prefixing relative paths. We can't
        // mutate POSIX cwd here without writing the shell support; for now
        // the shell already supports absolute paths and that's enough for
        // the bundled commands.
        const r = await shell.exec(command);
        const out: ShellResult = {
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          exitCode: r.exitCode ?? 0,
          durationMs: Date.now() - t0,
        };
        if (options?.signal?.aborted) {
          return { ...out, aborted: true };
        }
        return out;
      } catch (err) {
        return {
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 1,
          durationMs: Date.now() - t0,
        };
      }
    },

    async readFile(path: string): Promise<string> {
      const content = await vfs.readFile(path, { encoding: 'utf8' });
      if (typeof content !== 'string') {
        // SqliteFS returns Uint8Array if encoding isn't honored; decode defensively.
        return new TextDecoder().decode(content);
      }
      return content;
    },

    async readFileBuffer(path: string): Promise<Uint8Array> {
      const content = await vfs.readFile(path);
      if (typeof content === 'string') return new TextEncoder().encode(content);
      return content;
    },

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      // Ensure parent dir exists (matches inline executor convention).
      const dir = path.split('/').slice(0, -1).join('/');
      if (dir) {
        try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
      }
      await vfs.writeFile(path, content);
    },

    async readdir(path: string): Promise<DirEntry[]> {
      const names = await vfs.readdir(path);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const childPath = joinPath(path, name);
        const s = await safeStat(childPath);
        entries.push({
          name,
          path: childPath,
          isDirectory: s?.isDirectory ?? false,
          size: s?.isDirectory ? undefined : s?.size,
        });
      }
      return entries;
    },

    async stat(path: string): Promise<Stat | null> {
      return safeStat(path);
    },

    async exists(path: string): Promise<boolean> {
      try {
        return await vfs.exists(path);
      } catch {
        return false;
      }
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      await vfs.mkdir(path, { recursive: options?.recursive ?? true });
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      try {
        const s = await safeStat(path);
        if (s == null) {
          if (options?.force) return;
          throw new SandboxError(`Path not found: ${path}`, 'not_found');
        }
        if (s.isDirectory) {
          if (!options?.recursive) {
            // Try rmdir for empty dir; otherwise reject.
            if (vfs.rmdir) {
              await vfs.rmdir(path);
              return;
            }
            throw new SandboxError(`Cannot remove directory without recursive: ${path}`, 'permission');
          }
          if (vfs.removeRecursive) {
            await vfs.removeRecursive(path);
            return;
          }
          // Fallback: walk + unlink (slow path).
          await rmWalk(vfs, path);
          return;
        }
        await vfs.unlink(path);
      } catch (err) {
        if (options?.force) return;
        throw err instanceof SandboxError
          ? err
          : new SandboxError(`rm failed: ${err instanceof Error ? err.message : String(err)}`, 'internal', err);
      }
    },
  };
}

/** Slow recursive remove for VFS impls without removeRecursive(). */
async function rmWalk(vfs: VirtualVFS, path: string): Promise<void> {
  const names = await vfs.readdir(path);
  for (const name of names) {
    const child = path.endsWith('/') ? path + name : path + '/' + name;
    let s: { type: 'file' | 'dir' } | null;
    try { s = await vfs.stat(child); } catch { s = null; }
    if (s?.type === 'dir') await rmWalk(vfs, child);
    else await vfs.unlink(child);
  }
  if (vfs.rmdir) await vfs.rmdir(path);
}
