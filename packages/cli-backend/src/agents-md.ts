/**
 * AGENTS.md discovery: walk up from cwd to the filesystem root, root-most first (the order core's
 * admission expects). Gated by containment (bytes must live under the file's dir) and owner trust.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  discoverInstructionFiles,
  type AgentsMdSources, type InstructionCandidate, type InstructionFileProbe, type InstructionFileRead,
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

/** The host port: the bytes are read through a descriptor proven to be the sized inode, and never past its size. */
function readAsSized(candidate: Extract<Candidate, { kind: 'file' }>): InstructionFileRead {
  const changed = (reason: string): InstructionFileRead => ({ kind: 'unavailable', reason });
  let fd: number | undefined;

  try {
    fd = openSync(candidate.target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);

    if (opened.dev !== candidate.dev || opened.ino !== candidate.ino || opened.size !== candidate.bytes) {
      return changed('file changed after containment check');
    }

    const bytes = Buffer.alloc(candidate.bytes);
    let offset = 0;

    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);

      if (read === 0) break;
      offset += read;
    }

    if (offset !== bytes.length || fstatSync(fd).size !== candidate.bytes) return changed('file changed during bounded read');

    return { kind: 'text', text: bytes.toString('utf8') };
  } catch (error) {
    const code = errnoOf({ error });

    if (code === 'ENOENT' || code === 'ELOOP') return changed('file changed after containment check');

    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function hostProbe(dir: string, path: string): () => Promise<InstructionFileProbe> {
  return async () => {
    const candidate = candidateAt(dir, path);

    if (candidate?.kind !== 'file') return candidate;

    return { kind: 'file', bytes: candidate.bytes, read: async () => readAsSized(candidate) };
  };
}

/** Every directory from cwd up to the root, root-most first. `afterAdmission` is a test-only swap seam. */
export function discoverAgentsMd(
  cwd: string,
  limits: ModelWindow,
  trust: InstructionTrustResolver,
  afterAdmission?: () => void,
): Promise<AgentsMdSources> {
  const candidates: InstructionCandidate[] = [];
  let dir = resolve(cwd);

  for (;;) {
    const path = join(dir, 'AGENTS.md');
    candidates.push({ label: path, probe: hostProbe(dir, path) });
    const parent = dirname(dir);

    if (parent === dir) break;
    dir = parent;
  }

  return discoverInstructionFiles(candidates.reverse(), limits, trust, afterAdmission);
}
