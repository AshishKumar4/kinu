/**
 * Shadow-git checkpoint STORE FORMAT — the contract both engines write:
 *
 *   <base>/<agent>/<sha256(dir)[:16]>/   — bare GIT_DIR per working directory
 *     PROTEUS_WORKDIR                    — marker file with the target dir
 *     info/exclude                       — CHECKPOINT_EXCLUDES
 *     refs/proteus/<ms13>-<seq36>        — one ref per snapshot
 *
 * with parentless commits whose subject encodes the turn:
 * `turn=<id|-> session=<id|-> <reason>`.
 *
 * The cli-backend engine (createHostCheckpoints) imports this module; the
 * pc-agent daemon is deliberately dependency-free single-file JS and PINS the
 * same values as literals — cross-engine compatibility is enforced by the
 * parity test (cli-backend/tests/checkpoint-parity.test.ts), which round-trips
 * one store through both engines. Change anything here and that test breaks
 * until the daemon mirror is updated.
 */

import type { CheckpointTurnMeta } from './types.js';

/** Ref namespace inside each bare store — one ref per snapshot. */
export const CHECKPOINT_REF_PREFIX = 'refs/proteus';

/** Marker file in each store recording the absolute target directory. */
export const CHECKPOINT_WORKDIR_MARKER = 'PROTEUS_WORKDIR';

/** Default `info/exclude` contents — generated/derived trees never snapshot. */
export const CHECKPOINT_EXCLUDES = [
  '.git/', '.hg/', '.svn/',
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc',
  'dist/', 'build/', 'target/', 'out/', '.next/', '.nuxt/',
  '.cache/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', 'coverage/',
  '.DS_Store', 'Thumbs.db', '*.log',
] as const;

/** Commit subject for a snapshot: `turn=<id|-> session=<id|-> <reason>`.
 *  Null meta marks out-of-turn snapshots (pre-restore). */
export function checkpointSubject(meta: CheckpointTurnMeta | null, reason: string): string {
  const clean = (s: string) => s.replace(/[\n|]/g, ' ').trim() || '-';
  return `turn=${clean(meta?.turnId ?? '-')} session=${clean(meta?.sessionId ?? '-')} ${clean(reason)}`;
}

/** Inverse of checkpointSubject; unrecognized subjects keep the raw text as
 *  the reason with no turn attribution. */
export function parseCheckpointSubject(
  subject: string,
) {
  const m = /^turn=(\S+) session=(\S+) (.*)$/.exec(subject);
  if (!m) return { turnId: null, sessionId: null, reason: subject };
  return {
    turnId: m[1] === '-' ? null : m[1]!,
    sessionId: m[2] === '-' ? null : m[2]!,
    reason: m[3]!,
  };
}

/** Snapshot time from a `refs/proteus/<ms13>-<seq36>` ref name. */
export function checkpointRefTimestampMs(ref: string): number {
  const m = /(\d{13})-[0-9a-z]+$/.exec(ref);
  return m ? Number(m[1]) : 0;
}
