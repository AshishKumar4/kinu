import type { ReleaseStatus, ReleaseTransitionResult } from './types';

const ALLOWED = new Map<ReleaseStatus, ReadonlySet<ReleaseStatus>>([
  ['draft', new Set(['planning', 'rejected', 'failed'])],
  ['planning', new Set(['patching', 'rejected', 'failed'])],
  ['patching', new Set(['validating', 'planning', 'rejected', 'failed'])],
  ['validating', new Set(['preview_ready', 'patching', 'failed'])],
  ['preview_ready', new Set(['awaiting_approval', 'patching', 'rejected', 'failed'])],
  ['awaiting_approval', new Set(['applying', 'preview_ready', 'rejected', 'failed'])],
  ['applying', new Set(['deployed', 'rolled_back', 'failed'])],
  ['deployed', new Set(['rolled_back'])],
  ['rejected', new Set()],
  ['rolled_back', new Set()],
  ['failed', new Set(['planning', 'patching'])],
]);

/** States EARNED by the execution engine (apply/run_checks/deploy/rollback),
 *  never asserted: entering them requires real command results. The agent
 *  tool and the MCP release surface refuse manual transitions into
 *  these targets when an engine is wired; owner/UI RPCs keep full
 *  transition power. */
const ENGINE_OWNED_TARGETS = new Set<ReleaseStatus>([
  'validating', 'preview_ready', 'applying', 'deployed', 'rolled_back',
]);

export function isEngineOwnedTransitionTarget(to: ReleaseStatus): boolean {
  return ENGINE_OWNED_TARGETS.has(to);
}

export function assertReleaseTransition(
  from: ReleaseStatus,
  to: ReleaseStatus,
): ReleaseTransitionResult {
  if (from === to) return { ok: true, from, to };
  if (ALLOWED.get(from)?.has(to)) return { ok: true, from, to };
  return {
    ok: false,
    from,
    to,
    error: `Release transition ${from} -> ${to} is not allowed`,
  };
}
