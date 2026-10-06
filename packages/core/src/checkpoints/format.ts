// Shadow-git store format; the daemon carries a generated copy.

import type { CheckpointTurnMeta } from './types';

export const DEFAULT_CHECKPOINT_KEEP = 50;

export const CHECKPOINTS_UNAVAILABLE_NO_GIT = 'checkpoints unavailable: git not found';

export const CHECKPOINT_REF_PREFIX = 'refs/kinu';

export const CHECKPOINT_WORKDIR_MARKER = 'KINU_WORKDIR';

/** Generated/derived trees never snapshot. */
export const CHECKPOINT_EXCLUDES = [
  '.git/', '.hg/', '.svn/',
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc',
  'dist/', 'build/', 'target/', 'out/', '.next/', '.nuxt/',
  '.cache/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', 'coverage/',
  '.DS_Store', 'Thumbs.db', '*.log',
] as const;

/** Null meta marks out-of-turn snapshots (pre-restore). */
export function checkpointSubject(meta: CheckpointTurnMeta | null, reason: string): string {
  const clean = (field: string) => {
    const spaced = field.replace(/[\r\n|]/g, ' ').trim();

    return spaced === '' ? '-' : spaced;
  };

  return `turn=${clean(meta?.turnId ?? '-')} session=${clean(meta?.sessionId ?? '-')} ${clean(reason)}`;
}

/** Unrecognized subjects keep the raw text as the reason with no turn attribution. */
export function parseCheckpointSubject(
  subject: string,
) {
  const m = /^turn=(\S+) session=(\S+) (.*)$/.exec(subject);

  if (!m) return { turnId: null, sessionId: null, reason: subject };
  const turn = m[1];
  const session = m[2];
  const reason = m[3];

  if (turn === undefined || session === undefined || reason === undefined) {
    return { turnId: null, sessionId: null, reason: subject };
  }

  return {
    turnId: turn === '-' ? null : turn,
    sessionId: session === '-' ? null : session,
    reason,
  };
}

// A path `git add` cannot read is uncovered, not a failed checkpoint. Engines pass `--ignore-errors`
// (else git aborts, leaving later paths unstaged) under `LC_ALL=C`; these are git 2.53's exact lines.
const UNREADABLE_DIR = /^warning: could not open directory '(.+?)\/?': Permission denied$/;

const UNREADABLE_FILE = /^error: open\("(.+)"\): Permission denied$/;

const UNINDEXED_FILE = /^error: unable to index file '(.+?)'$/;

const ADD_FAILED = /^fatal: adding files failed$/;

interface StagingDiagnosis {
  /** Paths git could not read, sorted; absent from the tree and named in the reason. */
  unreadable: string[];
  /** Any other diagnostic, verbatim; non-empty means staging failed. */
  unexplained: string[];
}

function diagnoseStaging(stderr: string): StagingDiagnosis {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const unreadable = new Set<string>();

  for (const line of lines) {
    const denied = UNREADABLE_DIR.exec(line) ?? UNREADABLE_FILE.exec(line);
    const file = denied?.[1];

    if (file !== undefined) unreadable.add(file);
  }

  return {
    unreadable: [...unreadable].sort((left, right) => (left < right ? -1 : 1)),
    // Two passes so a consequence line is judged against the whole denial set.
    unexplained: lines.filter((line) => !isDenial(line, unreadable)),
  };
}

/** `code` null: git never finished, so its index is partial whatever it printed. */
export function stagingOutcome(code: number | null, stderr: string): { readonly unreadable: string[] } | { readonly failure: string } {
  if (code === null) return { failure: 'checkpoint staging failed: git add did not finish' };
  const diagnosis = diagnoseStaging(stderr);

  if (diagnosis.unexplained.length > 0 || (code !== 0 && diagnosis.unreadable.length === 0)) {
    return { failure: `checkpoint staging failed: ${stderr.trim()}` };
  }

  return { unreadable: diagnosis.unreadable };
}

function isDenial(line: string, unreadable: ReadonlySet<string>): boolean {
  if (UNREADABLE_DIR.test(line) || UNREADABLE_FILE.test(line)) return true;
  // Consequence lines are tolerated only alongside a denial; `unable to index file` also covers
  // non-permission failures.
  const unindexed = UNINDEXED_FILE.exec(line);

  if (unindexed) {
    const file = unindexed[1];

    return file !== undefined && unreadable.has(file);
  }

  return ADD_FAILED.test(line) && unreadable.size > 0;
}

const REASON_UNREADABLE_LIMIT = 3;

/** Unreadable paths ride in the free-text reason: the subject grammar is a two-engine on-disk contract. */
export function checkpointReason(reason: string, unreadable: readonly string[]): string {
  if (unreadable.length === 0) return reason;
  const shown = unreadable.slice(0, REASON_UNREADABLE_LIMIT);
  const rest = unreadable.length - shown.length;
  const more = rest > 0 ? ` +${String(rest)} more` : '';

  return `${reason} [skipped ${String(unreadable.length)} unreadable: ${shown.join(' ')}${more}]`;
}

/** Snapshot time from a `refs/kinu/<ms13>-<seq36>` ref name. */
export function checkpointRefTimestampMs(ref: string): number {
  const m = /(\d{13})-[0-9a-z]+$/.exec(ref);
  const stamp = m?.[1];

  return stamp === undefined ? 0 : Number(stamp);
}
