/**
 * Device consent model — per-(agent, device), ask-once-then-remember.
 *
 * Two tiers:
 *   'all_local_actions' — the base grant: the agent may run device actions
 *     (exec/read/write/…). File-plane access through the /pc mount is scoped
 *     to the consented subtree (the device connect dir / home).
 *   'full_filesystem'   — the stronger tier: additionally lifts the /pc
 *     subtree scope so absolute paths outside the consented directory are
 *     reachable. Implies the base grant. Never the default.
 */

export const DEVICE_CONSENT_SCOPE = 'all_local_actions';
export const DEVICE_CONSENT_SCOPE_FULL_FS = 'full_filesystem';

export type DeviceConsentScope = typeof DEVICE_CONSENT_SCOPE | typeof DEVICE_CONSENT_SCOPE_FULL_FS;

/** Narrow a stored scope string; unknown values mean the base tier. */
export function parseConsentScope(raw: string | null | undefined): DeviceConsentScope {
  return raw === DEVICE_CONSENT_SCOPE_FULL_FS ? DEVICE_CONSENT_SCOPE_FULL_FS : DEVICE_CONSENT_SCOPE;
}

/** Remembering a new grant never downgrades an existing stronger tier. */
export function mergeConsentScope(existing: string | null | undefined, granted: DeviceConsentScope): DeviceConsentScope {
  return parseConsentScope(existing) === DEVICE_CONSENT_SCOPE_FULL_FS
    ? DEVICE_CONSENT_SCOPE_FULL_FS
    : granted;
}

export interface DeviceActionSummary {
  method: string;
  command: string;
}

export function summarizeDeviceAction(method: string, params: unknown[]): DeviceActionSummary {
  if (method === 'exec') return { method, command: String(params[0] ?? '') };
  return {
    method,
    command: `${method}(${params.map((p) => summarizeParam(p)).join(', ')})`,
  };
}

function summarizeParam(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, 120);
}
