/**
 * The host filesystem as a file plane, via node:fs. Writes snapshot into the
 * bound shell's shadow-git checkpoints, so /undo covers them.
 */

import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileCheckpoints, ShellApprovalPolicy, VFS, VfsErrorCode } from '@kinu.run/core';
import {
  ERRNO, gateExec, LEGACY_WORKSPACE_ROOT, makeVfsError, reviewCommand, shellQuote, SLATES_ROOT, WORKSPACE_ROOT,
} from '@kinu.run/core';
import { type KinuError, tolerateAsync } from '@kinu.run/core/obs';
import * as v from 'valibot';

const nodeErrorSchema = v.object({
  code: v.optional(v.string()),
  message: v.optional(v.string()),
});

function isVfsErrorCode(code: string): code is VfsErrorCode {
  return code in ERRNO;
}

/** node:fs errno → core VfsError. Codes core does not model (EMFILE, ELOOP, …)
 *  pass through untranslated. */
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

function createHostMountVFS(root: string, checkpoints: FileCheckpoints | undefined): VFS {
  const snapshot = async (path: string, reason: string): Promise<void> => {
    if (!checkpoints) return;
    const workdir = checkpoints.workdirForPath(path);
    await checkpoints.ensureCheckpoint(withinRoot(root, workdir) ? workdir : root, reason);
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
        const s = await tolerateAsync(() => fs.stat(path), 'enoent');

        return s === undefined ? null : { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() };
      } catch (error) { throwVfsError({ error, syscall: 'stat', path }); }
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
 * The working directory as the workspace file plane; agent state stays in
 * `agentStateVfs`. Accepts relative paths, plane-root aliases (`/workspace`,
 * `/home/main`, `/`, and `/slates` for its `slates/`) and real absolute paths inside
 * the tree. With `outside`, any other absolute path is the user's machine: each operation is reviewed as the shell
 * command it amounts to and runs as that policy decides. A relative or aliased path that climbs out, a path with a
 * `..` segment, or any outside path without `outside`, is EACCES.
 */
export function createCwdPlaneVFS(cwd: string, checkpoints: FileCheckpoints | undefined, outside?: ShellApprovalPolicy): VFS {
  const root = resolve(cwd);
  const host = createHostMountVFS(root, checkpoints);
  const escapes = (path: string) => makeVfsError('EACCES', `path escapes the workspace directory ${root}: ${path}`, path);

  /** The host path, and whether it lies outside the directory. */
  const hostPath = (path: string) => {
    const direct = isAbsolute(path) ? resolve(path) : resolve(root, path || '.');

    // A real path inside the directory wins over every alias.
    if (withinRoot(root, direct)) return { at: direct, outside: false };
    const inner = isAbsolute(path) ? planeRootRelative(path) : null;

    if (inner !== null) {
      const mapped = resolve(root, inner || '.');

      if (withinRoot(root, mapped)) return { at: mapped, outside: false };

      throw escapes(path);
    }

    if (outside === undefined || !isAbsolute(path) || path.split('/').includes('..')) throw escapes(path);

    return { at: direct, outside: true };
  };

  /** `command` is what the operation would be in the shell, so the shell's rules and grants decide it. */
  const gated = async <T>(path: string, command: (at: string) => string, op: (at: string) => Promise<T>): Promise<T> => {
    const target = hostPath(path);

    if (!target.outside || outside === undefined) return op(target.at);

    const run = gateExec<{ readonly done: T } | { readonly refused: KinuError }>(
      async () => ({ done: await op(target.at) }),
      (refused) => ({ refused }),
      { name: 'workspace', filesOwner: 'user' },
      { policy: outside, review: async (cmd) => reviewCommand(cmd, 'user') },
    );

    const result = await run(command(shellQuote(target.at)));

    if ('refused' in result) throw makeVfsError('EACCES', result.refused.message, path);

    return result.done;
  };

  return {
    readFile: (path, opts) => gated(path, (at) => `cat ${at}`, (at) => host.readFile(at, opts)),
    writeFile: (path, data) => gated(path, (at) => `tee ${at}`, (at) => host.writeFile(at, data)),
    readdir: (path) => gated(path, (at) => `ls ${at}`, (at) => host.readdir(at)),
    stat: (path) => gated(path, (at) => `stat ${at}`, (at) => host.stat(at)),
    unlink: (path) => gated(path, (at) => `rm -rf ${at}`, (at) => host.unlink(at)),
    mkdir: (path, opts) => gated(path, (at) => `mkdir${opts?.recursive === true ? ' -p' : ''} ${at}`, (at) => host.mkdir(at, opts)),
    exists: (path) => gated(path, (at) => `test -e ${at}`, (at) => host.exists(at)),
  };
}

/** One table, so a new spelling cannot be honoured by only some operations: each root and the directory it names. */
const PLANE_ROOTS: readonly (readonly [root: string, directory: string])[] = [
  ['/', ''], [WORKSPACE_ROOT, ''], [LEGACY_WORKSPACE_ROOT, ''], ['/workspace', ''],
  // The workspace's slates are the project's own.
  [SLATES_ROOT, 'slates'],
];

function planeRootRelative(path: string): string | null {
  for (const [planeRoot, directory] of PLANE_ROOTS) {
    if (path === planeRoot) return directory;

    // `/` names the root only: `/etc/passwd` is never `<cwd>/etc/passwd`.
    if (planeRoot !== '/' && path.startsWith(`${planeRoot}/`)) {
      const inner = path.slice(planeRoot.length + 1);

      return directory === '' ? inner : `${directory}/${inner}`;
    }
  }

  return null;
}

function withinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);

  if (distance === '') return true;

  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}
