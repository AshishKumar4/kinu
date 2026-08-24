/**
 * /pc — the host filesystem as a composite mount.
 *
 * The cloud backend mounts the user's machine at /pc over the device tunnel
 * (createDeviceMountVFS). Locally the agent IS on that machine, so the same
 * plane is node:fs directly — no tunnel, no consent round-trip, the same
 * addresses. Without it the local backend had a `laptop` executor whose files
 * were unreachable by composite path, so every /pc address the cloud agent can
 * use silently compat-routed into /local.
 *
 * Writes snapshot into the same shadow-git checkpoints the bound shell and
 * `laptop.writeFile` use, so /undo covers file-plane mutations too.
 */

import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileCheckpoints, VFS, VfsErrorCode } from '@kinu.run/core';
import { ERRNO, makeVfsError, WORKSPACE_ROOT } from '@kinu.run/core';
import { classify, tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';

const nodeErrorSchema = v.object({
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});

function isVfsErrorCode(code: string): code is VfsErrorCode {
  return code in ERRNO;
}

/** node:fs errno → the core VfsError shape mounts are contracted to throw.
 *  Codes core does not model (EMFILE, ELOOP, …) pass through untranslated
 *  rather than being flattened into a lie about what went wrong. */
function nodeError(input: { error: unknown }): v.InferOutput<typeof nodeErrorSchema> | null {
  const parsed = v.safeParse(nodeErrorSchema, input.error);
  return parsed.success ? parsed.output : null;
}

function throwVfsError(input: { error: unknown; syscall: string; path: string }): never {
  const error = nodeError(input);
  if (error?.code && isVfsErrorCode(error.code)) {
    const message = error.message ?? String(input.error);
    throw makeVfsError(error.code, `${message}, ${input.syscall} '${input.path}'`, input.path);
  }
  throw input.error;
}

export function createHostMountVFS(checkpoints: FileCheckpoints | undefined): VFS {
  const snapshot = async (path: string, reason: string): Promise<void> => {
    await checkpoints?.ensureCheckpoint(checkpoints.workdirForPath(path), reason);
  };
  return {
    async readFile(path, opts) {
      try {
        return opts?.encoding === 'utf-8' || opts?.encoding === 'utf8'
          ? await fs.readFile(path, 'utf-8')
          : new Uint8Array(await fs.readFile(path));
      } catch (error) { throwVfsError({ error, syscall: 'open', path }); }
    },
    async writeFile(path, data) {
      await snapshot(path, 'file write');
      try {
        await fs.mkdir(dirname(path), { recursive: true });
        await fs.writeFile(path, data);
      } catch (error) { throwVfsError({ error, syscall: 'open', path }); }
    },
    async readdir(path) {
      try { return await fs.readdir(path); }
      catch (error) { throwVfsError({ error, syscall: 'scandir', path }); }
    },
    async stat(path) {
      try {
        const s = await fs.stat(path);
        return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
      } catch (error) {
        if (classify({ cause: error }) === 'enoent') return null;
        throwVfsError({ error, syscall: 'stat', path });
      }
    },
    async unlink(path) {
      await snapshot(path, 'file delete');
      try { await fs.rm(path, { recursive: true, force: true }); }
      catch (error) { throwVfsError({ error, syscall: 'unlink', path }); }
    },
    async mkdir(path, opts) {
      try { await fs.mkdir(path, { recursive: opts?.recursive ?? false }); }
      catch (error) { throwVfsError({ error, syscall: 'mkdir', path }); }
    },
    async exists(path) {
      return await tolerateAsync(() => fs.stat(path), 'enoent') !== undefined;
    },
  };
}

/**
 * The physical working directory as the workspace file plane.
 *
 * A local agent's canonical files ARE the directory it was started in: every
 * peer agent bound to that directory reads the same bytes, and a `run` command
 * and a `file` read address one tree instead of two. What the agent knows
 * about ITSELF — SOUL.md, its scaffold, its memory, its transcripts — stays in
 * the SQLite-backed plane behind `agentStateVfs`, so none of it is ever
 * written into the user's project.
 *
 * Three families of address name this one directory, and each has a live
 * producer, so the plane accepts all three rather than half of them:
 *
 *   relative       `src/x.ts`                the `file` tool, the shell's cwd
 *   plane root     `/workspace/skills/a.md`  core's SKILLS_DIR, release work roots
 *                  `/home/user/x`            workspacePath(), the prompt's root
 *                  `/`                       the mount table's root listing
 *   real absolute  `/home/me/proj/src/x.ts`  what the host shell itself prints
 *
 * Anything else absolute is refused with EACCES naming the path. That refusal
 * guards against path confusion; it is not a sandbox. `/pc` and the `laptop`
 * executor serve the whole machine on purpose (see createHostMountVFS), and
 * the check is lexical, so a symlink inside the tree still points where it
 * points.
 */
export function createCwdPlaneVFS(cwd: string, checkpoints: FileCheckpoints | undefined): VFS {
  const root = resolve(cwd);
  const host = createHostMountVFS(checkpoints);
  const hostPath = (path: string): string => {
    const direct = isAbsolute(path) ? resolve(path) : resolve(root, path || '.');
    // A real path inside the directory wins over every alias: the filesystem
    // is the authority on its own names, and this is the address the host
    // shell just printed.
    if (withinRoot(root, direct)) return direct;
    const inner = isAbsolute(path) ? planeRootRelative(path) : null;
    if (inner !== null) {
      const mapped = resolve(root, inner || '.');
      if (withinRoot(root, mapped)) return mapped;
    }
    throw makeVfsError('EACCES', `path escapes the workspace directory ${root}: ${path}`, path);
  };
  return {
    readFile: (path, opts) => host.readFile(hostPath(path), opts),
    writeFile: (path, data) => host.writeFile(hostPath(path), data),
    readdir: (path) => host.readdir(hostPath(path)),
    stat: (path) => host.stat(hostPath(path)),
    unlink: (path) => host.unlink(hostPath(path)),
    mkdir: (path, opts) => host.mkdir(hostPath(path), opts),
    exists: (path) => host.exists(hostPath(path)),
  };
}

/**
 * Absolute prefixes that name the plane's own root. One table, so a fourth
 * spelling cannot end up honoured by half the operations.
 */
const PLANE_ROOTS: readonly string[] = ['/', WORKSPACE_ROOT, '/workspace'];

/** The remainder of an absolute path under a plane root, or null when the path
 *  names something else entirely. */
function planeRootRelative(path: string): string | null {
  for (const planeRoot of PLANE_ROOTS) {
    if (path === planeRoot) return '';
    // `/` names the root and nothing beneath it: `/etc/passwd` is a real
    // absolute path, never `<cwd>/etc/passwd`.
    if (planeRoot !== '/' && path.startsWith(`${planeRoot}/`)) return path.slice(planeRoot.length + 1);
  }
  return null;
}

function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  if (distance === '') return true;
  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
