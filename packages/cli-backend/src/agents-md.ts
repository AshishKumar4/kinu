/**
 * AGENTS.md discovery: walk up from cwd to the filesystem root, root-most first (the order core's
 * admission expects). Gated by containment (bytes must live under the file's dir) and owner trust.
 */

import { Effect, Cause } from 'effect';
import { settle } from '@kinu.run/core/obs';
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
function candidateAt(dir: string, path: string): Effect.Effect<Candidate> {
  return Effect.gen(function* () {
    const entry = yield* probing(() => lstatSync(path), { ENOENT: null, ELOOP: SYMLINK_CYCLE });

    if ('answer' in entry) return entry.answer;

    if (!entry.value.isFile() && !entry.value.isSymbolicLink()) return null;

    const real = yield* probing(() => ({ target: realpathSync(path), realDir: realpathSync(dir) }), { ELOOP: SYMLINK_CYCLE, ENOENT: TARGET_MISSING });

    if ('answer' in real) return real.answer;
    const { target, realDir } = real.value;
    const rel = relative(realDir, target);

    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return { kind: 'unavailable', reason: 'symlink points outside its own directory' };
    }

    const stat = yield* probing(() => statSync(target), { ENOENT: TARGET_MISSING, ELOOP: SYMLINK_CYCLE });

    if ('answer' in stat) return stat.answer;

    if (!stat.value.isFile()) return null;

    return {
      kind: 'file',
      bytes: stat.value.size,
      target,
      dev: stat.value.dev,
      ino: stat.value.ino,
    };
  });
}

const SYMLINK_CYCLE: Candidate = { kind: 'unavailable', reason: 'symlink cycle' };

const TARGET_MISSING: Candidate = { kind: 'unavailable', reason: 'symlink target is missing' };

/** One fs read: an errno the table names is that answer; any other failure (EACCES, EIO) stays the read's own. */
function probing<A>(read: () => A, answers: Readonly<Record<string, Candidate>>): Effect.Effect<{ readonly value: A } | { readonly answer: Candidate }> {
  return Effect.catchCause(Effect.sync(() => ({ value: read() })), (failed) => {
    const error = Cause.squash(failed);
    const code = errnoOf({ error });

    return code !== undefined && Object.hasOwn(answers, code) ? Effect.succeed({ answer: answers[code] ?? null }) : Effect.die(error);
  });
}

/** The host port: the bytes are read through a descriptor proven to be the sized inode, and never past its size. */
function readAsSized(candidate: Extract<Candidate, { kind: 'file' }>): Effect.Effect<InstructionFileRead> {
  const changed = (reason: string): InstructionFileRead => ({ kind: 'unavailable', reason });

  return Effect.suspend(() => {
    let fd: number | undefined;

    return Effect.ensuring(Effect.catchCause(Effect.sync((): InstructionFileRead => {
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
    }), (failed) => {
      const code = errnoOf({ error: Cause.squash(failed) });

      return code === 'ENOENT' || code === 'ELOOP'
        ? Effect.succeed(changed('file changed after containment check')) : Effect.failCause(failed);
    }), Effect.sync(() => { if (fd !== undefined) closeSync(fd); }));
  });
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
    const candidateDir = dir;
    candidates.push({ label: path, probe: (): Promise<InstructionFileProbe> => settle(Effect.gen(function* () {
      const candidate = yield* candidateAt(candidateDir, path);

      if (candidate?.kind !== 'file') return candidate;

      return { kind: 'file', bytes: candidate.bytes, read: () => settle(readAsSized(candidate)) };
    })) });
    const parent = dirname(dir);

    if (parent === dir) break;
    dir = parent;
  }

  return discoverInstructionFiles(candidates.reverse(), limits, trust, afterAdmission);
}
