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
