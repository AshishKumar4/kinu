/**
 * Device consent — per-(agent, device), ask-once-then-remember, and the
 * registry of prompts waiting on an answer.
 *
 * Two tiers:
 *   'all_local_actions' — the base grant: the agent may run device actions
 *     (exec/read/write/…). Laptop file access is scoped
 *     to the consented subtree (the device connect dir / home).
 *   'full_filesystem'   — the stronger tier: additionally lifts the laptop
 *     subtree scope so absolute paths outside the consented directory are
 *     reachable. Implies the base grant. Never the default.
 *
 * A prompt that nobody answered is not one of them. It used to resolve as
 * `deny`, so the model was told its request had been refused when the owner
 * was simply away from the keyboard — and an agent meant to run for hours
 * unattended reads a refusal as policy and stops asking, turning a temporary
 * absence into a permanent capability loss. The two outcomes carry different
 * words.
 *
 * The registry below is the waiting half: raise a prompt, park the caller on a
 * promise, and settle it when the owner answers or when the prompt expires. It
 * was written as Durable Object state, and nothing about it is: the only
 * platform-shaped piece is telling whoever can answer that a decision is
 * waiting, which arrives as one `announce` callback.
 */

import type { DynamicApproval } from '../prompting/volatile-context.js';
import * as v from 'valibot';

export const DEVICE_CONSENT_SCOPE = 'all_local_actions';
export const DEVICE_CONSENT_SCOPE_FULL_FS = 'full_filesystem';

export type DeviceConsentScope = typeof DEVICE_CONSENT_SCOPE | typeof DEVICE_CONSENT_SCOPE_FULL_FS;

/** How a consent prompt settled. `timeout` is NOT a decision — nobody made
 *  one. It is never remembered, and it never becomes a stored policy. */
export type DeviceConsentDecision = 'once' | 'always' | 'deny' | 'timeout';

/** What the owner can actually answer. `timeout` is not among them. */
export type DeviceConsentAnswer = Exclude<DeviceConsentDecision, 'timeout'>;

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

function summarizeParam<Value>(value: Value): string {
  const text = v.safeParse(v.string(), value);
  const rendered = text.success ? text.output : JSON.stringify(value);
  return (rendered ?? String(value)).slice(0, 120);
}

/** What the agent is asking permission for. */
export interface DeviceConsentRequest {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly method: string;
  readonly command: string;
  readonly scope: string;
}

/** One waiting prompt, as a surface renders it. Carries the id the answer is
 *  addressed to, so a client that reloads can re-render its cards. */
export interface PendingDeviceConsent extends DeviceConsentRequest {
  readonly consentId: string;
  readonly createdAt: number;
}

/** What the registry tells the host as prompts come and go — the one
 *  platform-shaped part. A DO broadcasts it to connected sockets; a local
 *  surface prints it. */
export type DeviceConsentNotice =
  | { readonly kind: 'raised'; readonly consent: PendingDeviceConsent }
  | { readonly kind: 'settled'; readonly consentId: string };

export interface DeviceConsentRegistryDeps {
  announce(notice: DeviceConsentNotice): void;
  /** Mint a consent id. Injected so a host can keep its own id vocabulary and
   *  so tests are deterministic. */
  newId(): string;
  /** How long an unanswered prompt waits before it expires. */
  timeoutMs?: number;
  now?(): number;
}

/** How long an unanswered prompt waits by default. Long enough that a user who
 *  stepped away can still come back to it, short enough that a device call is
 *  never parked forever. */
export const DEVICE_CONSENT_TIMEOUT_MS = 5 * 60_000;

interface Waiting {
  readonly view: PendingDeviceConsent;
  readonly settle: (decision: DeviceConsentDecision) => void;
}

/**
 * Prompts waiting on the owner.
 *
 * `request` resolves when someone answers, or as `timeout` when nobody does —
 * so a device call is never left hanging, and never told it was refused when
 * it simply was not seen.
 */
export class DeviceConsentRegistry {
  private readonly waiting = new Map<string, Waiting>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DeviceConsentRegistryDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEVICE_CONSENT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Raise a prompt and wait for it to settle. */
  request(req: DeviceConsentRequest): Promise<DeviceConsentDecision> {
    const consentId = this.deps.newId();
    const view: PendingDeviceConsent = { ...req, consentId, createdAt: this.now() };
    this.deps.announce({ kind: 'raised', consent: view });
    return new Promise<DeviceConsentDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(consentId)) return;
        this.deps.announce({ kind: 'settled', consentId });
        resolve('timeout');
      }, this.timeoutMs);
      this.waiting.set(consentId, {
        view,
        settle: (decision) => { clearTimeout(timer); resolve(decision); },
      });
    });
  }

  /** The owner answered. False when the id is unknown — already settled, or
   *  from a previous instance of this host. */
  resolve(consentId: string, decision: DeviceConsentAnswer): boolean {
    const pending = this.waiting.get(consentId);
    if (!pending) return false;
    this.waiting.delete(consentId);
    this.deps.announce({ kind: 'settled', consentId });
    // Anything unrecognised is the weakest grant, never a stronger one.
    pending.settle(decision === 'always' || decision === 'deny' ? decision : 'once');
    return true;
  }

  /** Everything still waiting — so a client that reloaded re-renders its cards. */
  list(): PendingDeviceConsent[] {
    return [...this.waiting.values()].map((p) => p.view);
  }

  /** The waiting prompts as the per-step dynamic context block names them, so
   *  the agent can tell a gated action stuck on the human from one that failed. */
  approvals(): DynamicApproval[] {
    return this.list().map((c) => ({
      id: c.consentId,
      kind: 'device consent',
      detail: `${c.deviceLabel}: ${c.command}`,
    }));
  }
}
