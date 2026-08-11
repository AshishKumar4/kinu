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
 *
 * A prompt that nobody answered is not one of them. It used to resolve as
 * `deny`, so the model was told its request had been refused when the owner
 * was simply away from the keyboard — and an agent meant to run for hours
 * unattended reads a refusal as policy and stops asking, turning a temporary
 * absence into a permanent capability loss. The two outcomes now carry
 * different words.
 */

export const DEVICE_CONSENT_SCOPE = 'all_local_actions';
export const DEVICE_CONSENT_SCOPE_FULL_FS = 'full_filesystem';

export type DeviceConsentScope = typeof DEVICE_CONSENT_SCOPE | typeof DEVICE_CONSENT_SCOPE_FULL_FS;

/** How a consent prompt settled. `timeout` is NOT a decision — nobody made
 *  one. It is never remembered, and it never becomes a stored policy. */
export type DeviceConsentDecision = 'once' | 'always' | 'deny' | 'timeout';

/** The owner said no. A policy decision: asking again immediately is noise. */
export const DEVICE_CONSENT_DENIED =
  'device use was not approved — the owner declined this request';

/** Nobody answered before the prompt expired. Deliberately worded so a model
 *  reading it cannot mistake it for a refusal: the capability is intact and
 *  the request is worth making again when someone is around. */
export const DEVICE_CONSENT_UNANSWERED =
  'device use is still unapproved: the consent prompt expired with no answer, so nobody has decided yet. '
  + 'This is NOT a refusal — the owner was away. Carry on with what does not need the device, and ask again later.';

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
