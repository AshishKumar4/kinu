/**
 * AGENTS.md discovery: walk up from cwd to the filesystem root, root-most first (the order core's
 * admission expects). Gated by containment (bytes must live under the file's dir) and owner trust.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  admitAgentsMd,
  type AgentsMdFile, type AgentsMdReference, type AgentsMdSources,
  type AgentsMdUnavailable,
  type InstructionTrustResolver, type ModelWindow,
} from '@kinu.run/core';
import * as v from 'valibot';

/**
 * Size `<dir>/AGENTS.md` may contribute, or null. `lstatSync` first: `statSync` follows an
 * escaping link like `AGENTS.md -> /etc/passwd`. In-tree symlinks stay legal (monorepos share them).
 */
/** The descriptor opens only after budget admission; fstat proves the bytes read came from the
 *  validated inode, not one swapped between validation and open. */
type Candidate =
  | {
    readonly kind: 'file';
    readonly bytes: number;
    readonly target: string;
    readonly dev: number;
    readonly ino: number;
  }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | null;

/** The errno a node:fs throw carries, or undefined. */
const ERRNO_SCHEMA = v.object({ code: v.optional(v.string()) });

function errnoOf(thrown: { readonly error: unknown }): string | undefined {
  const parsed = v.safeParse(ERRNO_SCHEMA, thrown.error);

  return parsed.success ? parsed.output.code : undefined;
}

/**
 * Resolve one candidate; a symlink cycle (ELOOP) or ENOENT reports unavailable instead of failing
 * the turn. EACCES/EIO still propagate: a broken disk must not become a silently emptier prompt.
 */
function candidateAt(dir: string, path: string): Candidate {
  let entry;

  try {
    entry = lstatSync(path);
  } catch (error) {
    const code = errnoOf({ error });

    if (code === 'ENOENT') return null;

    if (code === 'ELOOP') return { kind: 'unavailable', reason: 'symlink cycle' };
    throw error;
  }

  if (!entry.isFile() && !entry.isSymbolicLink()) return null;

  let target;
  let realDir;

  try {
    target = realpathSync(path);
    realDir = realpathSync(dir);
  } catch (error) {
    const code = errnoOf({ error });

    if (code === 'ELOOP') return { kind: 'unavailable', reason: 'symlink cycle' };

    if (code === 'ENOENT') return { kind: 'unavailable', reason: 'symlink target is missing' };
    throw error;
  }

  const rel = relative(realDir, target);

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { kind: 'unavailable', reason: 'symlink points outside its own directory' };
  }

  let stat;

  try {
    stat = statSync(target);
  } catch (error) {
    const code = errnoOf({ error });

    if (code === 'ENOENT') return { kind: 'unavailable', reason: 'symlink target is missing' };

    if (code === 'ELOOP') return { kind: 'unavailable', reason: 'symlink cycle' };
    throw error;
  }

  if (!stat.isFile()) return null;

  return {
    kind: 'file',
    bytes: stat.size,
    target,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/** `afterAdmission` is a test-only fault-injection seam for the swap-after-admission regression. */
export function discoverAgentsMd(
  cwd: string,
  limits: ModelWindow,
  trust: InstructionTrustResolver,
  afterAdmission?: () => void,
): AgentsMdSources {
  const candidates: Array<{
    readonly ref: AgentsMdReference;
    readonly target: string;
    readonly dev: number;
    readonly ino: number;
  }> = [];

  const unavailable: AgentsMdUnavailable[] = [];
  let dir = resolve(cwd);

  for (;;) {
    const path = join(dir, 'AGENTS.md');
    const candidate = candidateAt(dir, path);

    if (candidate?.kind === 'file') candidates.push({
      ref: { path, bytes: candidate.bytes },
      target: candidate.target,
      dev: candidate.dev,
      ino: candidate.ino,
    });
    else if (candidate?.kind === 'unavailable') unavailable.push({ path, reason: candidate.reason });
    const parent = dirname(dir);

    if (parent === dir) break;
    dir = parent;
  }

  candidates.reverse();
  unavailable.reverse();

  const admission = admitAgentsMd(candidates.map((candidate) => candidate.ref), limits);
  const allowed = new Set(admission.admit);
  afterAdmission?.();
  const admitted: AgentsMdFile[] = [];

  for (const candidate of candidates) {
    if (!allowed.has(candidate.ref)) continue;
    let fd: number | undefined;

    try {
      fd = openSync(candidate.target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd);

      if (
        opened.dev !== candidate.dev
        || opened.ino !== candidate.ino
        || opened.size !== candidate.ref.bytes
      ) {
        unavailable.push({
          path: candidate.ref.path,
          reason: 'file changed after containment check',
        });
        continue;
      }

      const bytes = Buffer.alloc(candidate.ref.bytes);
      let offset = 0;

      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);

        if (read === 0) break;
        offset += read;
      }

      const finished = fstatSync(fd);

      if (offset !== bytes.length || finished.size !== candidate.ref.bytes) {
        unavailable.push({
          path: candidate.ref.path,
          reason: 'file changed during bounded read',
        });
        continue;
      }

      const content = bytes.toString('utf8');

      if (!content.trim()) continue;
      admitted.push({
        path: candidate.ref.path,
        content,
        trust: trust(candidate.ref.path, content),
      });
    } catch (error) {
      const code = errnoOf({ error });

      if (code === 'ENOENT' || code === 'ELOOP') {
        unavailable.push({
          path: candidate.ref.path,
          reason: 'file changed after containment check',
        });
        continue;
      }

      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return { admitted, referenced: admission.referenced, unavailable };
}
