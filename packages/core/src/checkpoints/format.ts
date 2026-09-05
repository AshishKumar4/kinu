/**
 * Shadow-git checkpoint STORE FORMAT — the contract both engines write:
 *
 *   <base>/<agent>/<sha256(dir)[:16]>/   — bare GIT_DIR per working directory
 *     KINU_WORKDIR                    — marker file with the target dir
 *     info/exclude                       — CHECKPOINT_EXCLUDES
 *     refs/kinu/<ms13>-<seq36>        — one ref per snapshot
 *
 * with parentless commits whose subject encodes the turn:
 * `turn=<id|-> session=<id|-> <reason>`.
 *
 * pc-agent daemon is deliberately dependency-free single-file JS and PINS the
 * same values as literals — cross-engine compatibility is pinned by the
 * parity test (cli-backend/tests/checkpoint-parity.test.ts), which round-trips
 * one happy-path store through both engines. That is one store, not the edge
 * cases: subjects carrying a newline or a pipe, an absent turn, a ref outside
 * the naming scheme — those live in core/tests/unit-checkpoint-format.test.ts.
 * Change anything here and both tests break until the daemon mirror is updated.
 */

import type { CheckpointTurnMeta } from './types';

/** Ref namespace inside each bare store — one ref per snapshot. */
export const CHECKPOINT_REF_PREFIX = 'refs/kinu';

/** Marker file in each store recording the absolute target directory. */
export const CHECKPOINT_WORKDIR_MARKER = 'KINU_WORKDIR';

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
  const clean = (s: string) => s.replace(/[\r\n|]/g, ' ').trim() || '-';
  return `turn=${clean(meta?.turnId ?? '-')} session=${clean(meta?.sessionId ?? '-')} ${clean(reason)}`;
}

/** Inverse of checkpointSubject; unrecognized subjects keep the raw text as
 *  the reason with no turn attribution. */
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

/**
 * What `git add` said it could not READ, separated from what it says FAILED.
 *
 * A checkpoint stages a whole directory, and not every path in one belongs to
 * the agent — a scratch tree with a `systemd-private-*` child in it, a project
 * holding another user's files. A path it may not read is not a broken
 * checkpoint. It is a path the snapshot does not cover, which is a
 * fact to record, not a reason to refuse the mutation the snapshot precedes. The
 * live defect this replaces failed 3 of 4 `execute_tools` calls in one run with
 * `checkpoint staging failed: warning: could not open directory
 * 'systemd-private-…'`.
 *
 * The three lines are git's own, measured against git 2.53 rather than recalled
 * (`add -A --ignore-errors` over a work tree holding a mode-000 directory and a
 * mode-000 file — exit 1, everything readable still staged, `write-tree` clean):
 *
 *     warning: could not open directory 'systemd-private-abc/': Permission denied
 *     error: open("locked.txt"): Permission denied
 *     error: unable to index file 'locked.txt'
 *
 * plus, WITHOUT `--ignore-errors`, a trailing `fatal: adding files failed` and an
 * abort that leaves every later path unstaged — which is why the engines pass
 * `--ignore-errors` and why a truncated tree is the alternative to this parse.
 *
 * Both engines run under `LC_ALL=C` so these are the strings git actually emits.
 */
const UNREADABLE_DIR = /^warning: could not open directory '(.+?)\/?': Permission denied$/;
const UNREADABLE_FILE = /^error: open\("(.+)"\): Permission denied$/;
const UNINDEXED_FILE = /^error: unable to index file '(.+?)'$/;
const ADD_FAILED = /^fatal: adding files failed$/;

export interface StagingDiagnosis {
  /** Work-tree-relative paths git could not read, sorted. Absent from the tree
   *  this staging produced, and named in the checkpoint's reason. */
  unreadable: string[];
  /** Every other diagnostic, verbatim. Non-empty means staging failed on its
   *  own account and the caller must not call the snapshot good. */
  unexplained: string[];
}

export function diagnoseStaging(stderr: string): StagingDiagnosis {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const unreadable = new Set<string>();
  for (const line of lines) {
    const denied = UNREADABLE_DIR.exec(line) ?? UNREADABLE_FILE.exec(line);
    const path = denied?.[1];
    if (path !== undefined) unreadable.add(path);
  }
  return {
    unreadable: [...unreadable].sort(),
    // Two passes, so a consequence line is judged against the whole denial set
    // rather than against the denials that happened to come before it.
    unexplained: lines.filter((line) => !isDenial(line, unreadable)),
  };
}

function isDenial(line: string, unreadable: ReadonlySet<string>): boolean {
  if (UNREADABLE_DIR.test(line) || UNREADABLE_FILE.test(line)) return true;
  // `unable to index file` and `adding files failed` carry no information of
  // their own: the first restates a denial by path, the second restates that
  // some file was denied. Neither is tolerated without the denial it follows —
  // `unable to index file` also covers failures that are not permission ones.
  const unindexed = UNINDEXED_FILE.exec(line);
  if (unindexed) {
    const path = unindexed[1];
    return path !== undefined && unreadable.has(path);
  }
  return ADD_FAILED.test(line) && unreadable.size > 0;
}

/** Names in a reason before it turns into a paragraph. */
const REASON_UNREADABLE_LIMIT = 3;

/**
 * The reason a snapshot records, carrying the paths it could not read.
 *
 * In the reason rather than in a new subject field because the subject grammar
 * is a two-engine contract over stores already on disk, and `reason` is the free
 * text both engines already round-trip — so `/undo` shows an incomplete snapshot
 * as incomplete without a store migration for a diagnostic.
 */
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
