import type { ProductChangeStatus, ProductChangeTransitionResult } from './types.js';

const TERMINAL = new Set<ProductChangeStatus>(['deployed', 'rejected', 'rolled_back', 'failed']);

const ALLOWED: Record<ProductChangeStatus, ReadonlySet<ProductChangeStatus>> = {
  draft: new Set(['planning', 'rejected', 'failed']),
  planning: new Set(['patching', 'rejected', 'failed']),
  patching: new Set(['validating', 'planning', 'rejected', 'failed']),
  validating: new Set(['preview_ready', 'patching', 'failed']),
  preview_ready: new Set(['awaiting_approval', 'patching', 'rejected', 'failed']),
  awaiting_approval: new Set(['applying', 'preview_ready', 'rejected', 'failed']),
  applying: new Set(['deployed', 'rolled_back', 'failed']),
  deployed: new Set(['rolled_back']),
  rejected: new Set([]),
  rolled_back: new Set([]),
  failed: new Set(['planning', 'patching']),
};

export function isProductChangeTerminal(status: ProductChangeStatus): boolean {
  return TERMINAL.has(status);
}

/** States EARNED by the execution engine (apply/run_checks/deploy/rollback),
 *  never asserted: entering them requires real command results. The agent
 *  tool refuses manual transitions into these targets when an engine is
 *  wired; owner/UI RPCs keep full transition power. */
const ENGINE_OWNED_TARGETS = new Set<ProductChangeStatus>([
  'validating', 'preview_ready', 'applying', 'deployed', 'rolled_back',
]);

export function isEngineOwnedTransitionTarget(to: ProductChangeStatus): boolean {
  return ENGINE_OWNED_TARGETS.has(to);
}

export function assertProductChangeTransition(
  from: ProductChangeStatus,
  to: ProductChangeStatus,
): ProductChangeTransitionResult {
  if (from === to) return { ok: true, from, to };
  if (ALLOWED[from]?.has(to)) return { ok: true, from, to };
  return {
    ok: false,
    from,
    to,
    error: `Product change transition ${from} -> ${to} is not allowed`,
  };
}
