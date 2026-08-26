/**
 * Platform capabilities and the decision they feed.
 *
 * CaptureSound is decided, not assumed: the deployed probe reports which
 * primitives the container actually has, and `decideCaptureMechanism` maps
 * that report onto exactly one verdict — a capable mechanism with its cut
 * semantics, or a typed no-go naming what is missing. An unknown primitive is
 * treated as absent (fail-closed): a mechanism whose premise was never
 * measured does not get the benefit of the doubt.
 *
 * Preference order when both are available: freeze-drain first. Its demands
 * (stop writers, prove no fork escape) exist in stock containers, while full
 * mutation-journal coverage needs an interception plane — FUSE or fanotify —
 * that changes how the workspace itself is mounted. The simpler sufficient
 * dependency wins.
 */

import * as v from 'valibot';

/** Closed set of platform facts the probe measures. */
export const CAPTURE_CAPABILITIES = [
  /** All writer processes can be stopped in place (SIGSTOP or freezer). */
  'process-freeze',
  /** cgroup v2 freezer is usable (born-frozen children: the fork-proof). */
  'cgroup-freezer',
  /** With the freeze held, no new writer appeared across a sampling window. */
  'fork-proof-window',
  /** A whole-filesystem flush exists (syncfs syscall or `sync -f`). */
  'syncfs',
  /** fanotify with permission events is possible (CAP_SYS_ADMIN held). */
  'fanotify-cap-sys-admin',
  /** A FUSE filesystem can be mounted over the writable upper. */
  'fuse-mount',
  /** Watch-queue overflow is observable rather than silent. */
  'inotify-overflow-visible',
  /** The process view of /proc is scoped so "all writers" is enumerable. */
  'pid-namespace',
] as const;

export type CaptureCapabilityId = (typeof CAPTURE_CAPABILITIES)[number];

export const CAPTURE_CHECK_STATUSES = ['present', 'absent', 'unknown'] as const;
export type CaptureCheckStatus = (typeof CAPTURE_CHECK_STATUSES)[number];

export const CapabilityCheckSchema = v.strictObject({
  id: v.picklist(CAPTURE_CAPABILITIES),
  status: v.picklist(CAPTURE_CHECK_STATUSES),
  detail: v.pipe(v.string(), v.minLength(1)),
});
export type CapabilityCheck = v.InferOutput<typeof CapabilityCheckSchema>;

export const CaptureCapabilityReportSchema = v.strictObject({
  probeVersion: v.literal(1),
  platform: v.pipe(v.string(), v.minLength(1)),
  kernel: v.pipe(v.string(), v.minLength(1)),
  checks: v.array(CapabilityCheckSchema),
});
export type CaptureCapabilityReport = v.InferOutput<typeof CaptureCapabilityReportSchema>;

export const CAPTURE_NO_GO_REASONS = [
  'no-writer-quiesce',
  'no-fork-proof',
  'no-journal-interception',
  'probe-unusable',
] as const;
export type CaptureNoGoReason = (typeof CAPTURE_NO_GO_REASONS)[number];

/**
 * THE verdict this whole module exists to produce. Exactly one arm applies;
 * the caveats travel with the winner so downstream durability claims stay
 * honest about weaker primitives.
 */
export type CaptureMechanismDecision =
  | {
      readonly verdict: 'capable';
      readonly mechanism: 'freeze-drain';
      readonly cutSemantics: 'freeze-barrier';
      readonly caveats: readonly string[];
    }
  | {
      readonly verdict: 'capable';
      readonly mechanism: 'mutation-journal';
      readonly cutSemantics: 'journal-seq';
      readonly caveats: readonly string[];
    }
  | {
      readonly verdict: 'no-go';
      readonly reasons: readonly CaptureNoGoReason[];
    };

function statusOf(report: CaptureCapabilityReport, id: CaptureCapabilityId): CaptureCheckStatus {
  for (const check of report.checks) if (check.id === id) return check.status;
  return 'unknown';
}

function isPresent(report: CaptureCapabilityReport, id: CaptureCapabilityId): boolean {
  return statusOf(report, id) === 'present';
}

/**
 * Decide from a measured report. Rules:
 *
 *   freeze-drain requires the complete barrier, not merely a signal that
 *     stopped one test child: scoped `/proc`, a usable cgroup freezer, a
 *     successful process stop, and the born-frozen proof must all be present.
 *     syncfs absence degrades to a caveat because a staged read sees dirty
 *     pages; it does not turn an exact cut into a torn one.
 *
 *   mutation-journal requires total interception coverage — a real FUSE mount
 *     over the upper OR real fanotify permission events. A watcher is never a
 *     substitute: Q_OVERFLOW is tested separately and its journal path refuses
 *     unconditionally after overflow.
 *
 *   otherwise no-go, naming every failed premise.
 */
export function decideCaptureMechanism(report: CaptureCapabilityReport): CaptureMechanismDecision {
  if (report.checks.length === 0) return { verdict: 'no-go', reasons: ['probe-unusable'] };

  const freezeOk =
    isPresent(report, 'pid-namespace') &&
    isPresent(report, 'process-freeze') &&
    isPresent(report, 'cgroup-freezer') &&
    isPresent(report, 'fork-proof-window');
  const journalCoverage =
    isPresent(report, 'fuse-mount') || isPresent(report, 'fanotify-cap-sys-admin');

  if (freezeOk) {
    const caveats = isPresent(report, 'syncfs')
      ? []
      : ['no whole-filesystem flush: staging falls back to per-file fsync'];
    return { verdict: 'capable', mechanism: 'freeze-drain', cutSemantics: 'freeze-barrier', caveats };
  }

  if (journalCoverage) {
    return {
      verdict: 'capable',
      mechanism: 'mutation-journal',
      cutSemantics: 'journal-seq',
      caveats: [],
    };
  }

  const reasons: CaptureNoGoReason[] = [];
  if (statusOf(report, 'process-freeze') !== 'present' ||
      statusOf(report, 'cgroup-freezer') !== 'present' ||
      statusOf(report, 'pid-namespace') !== 'present') {
    reasons.push('no-writer-quiesce');
  } else if (statusOf(report, 'fork-proof-window') !== 'present') {
    reasons.push('no-fork-proof');
  }
  if (!journalCoverage) reasons.push('no-journal-interception');
  return { verdict: 'no-go', reasons };
}
