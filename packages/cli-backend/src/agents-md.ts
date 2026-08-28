/**
 * AGENTS.md discovery for the local backend — walk up from cwd to the
 * filesystem root, statting every AGENTS.md on the way (the agents.md
 * standard's nearest-file-wins chain). Candidates are ordered root-most first,
 * nearest last — the order core's admission spends and its renderer expects —
 * and only the ones core admits are ever read.
 *
 * Two things gate a candidate before its bytes can reach a prompt. Containment:
 * a file found at `<dir>/AGENTS.md` may only contribute bytes that actually
 * live under `<dir>`. Trust: the bytes that survive are classified by the
 * owner's approval resolver, so unapproved instructions can be placed as
 * reference material rather than as system instructions.
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
 * The size of the file `<dir>/AGENTS.md` is allowed to contribute, or null when
 * the entry contributes nothing.
 *
 * `statSync` follows symlinks, so statting the path alone cannot tell an
 * in-tree file from `AGENTS.md -> /etc/passwd`; the escaping link would be
 * admitted and its bytes read straight into the prompt. `lstatSync` answers
 * what the entry IS, and only then is a link resolved.
 *
 * An in-tree symlink stays legal — monorepos share one rule file across
 * packages that way. Only an ESCAPING link is refused: the discovery directory
 * is the authority for the bytes it offers, and a link out of it is a claim
 * that directory cannot make. Containment is per-discovery-directory because
 * the walk deliberately runs to the filesystem root; there is no single
 * workspace root to check against.
 */
/** A validated candidate records the canonical inode that passed containment.
 * The descriptor is opened only AFTER budget admission, so an oversized file
 * remains metadata-only; fstat then proves the bytes read came from that same
 * inode rather than a path an agent swapped between validation and open. */
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
/** The errno a node:fs throw carries, or undefined when it carries none.
 *
 *  Parsed rather than cast, and shaped like `nodeError` in host-mount.ts so this
 *  package reads one way about the same question. A cast plus a `typeof` check
 *  would assert the shape and then re-check it, which is two statements of the
 *  same doubt. */
const ERRNO_SCHEMA = v.object({ code: v.optional(v.string()) });

function errnoOf(thrown: { readonly error: unknown }): string | undefined {
  const parsed = v.safeParse(ERRNO_SCHEMA, thrown.error);
  return parsed.success ? parsed.output.code : undefined;
}

/**
 * Resolve one candidate without ever letting a bad link fail the turn.
 *
 * ELOOP is the case worth naming. `AGENTS.md -> AGENTS.md`, or a two-link cycle
 * between two of them, makes both `statSync` and `realpathSync` throw, and that
 * throw used to propagate out of discovery and take the whole turn with it — one
 * `ln -s` as a denial of service, from a plane the agent writes. A cycle is not
 * an instruction file, so it is reported as unavailable and assembly carries on
 * with the files that are real.
 *
 * Only ENOENT and ELOOP are absorbed, and only here. An EACCES or EIO still
 * propagates: those say something is wrong with the machine, and swallowing them
 * would turn a broken disk into a silently emptier prompt.
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

/**
 * Discover instruction files from the local tree.
 *
 * `afterAdmission` is a narrow fault-injection seam for the hostile replacement
 * regression: production omits it, while the test swaps the validated target
 * between budget admission and descriptor open to prove no out-of-tree bytes
 * reach the prompt.
 */
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
