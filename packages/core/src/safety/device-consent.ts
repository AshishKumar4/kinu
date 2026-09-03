/**
 * Device binding — per-(workspace, device), asked once, then remembered, and
 * the registry of prompts waiting on an answer.
 *
 * ONE question, asked once per workspace: may this workspace use this machine?
 * There is no second tier to grant and no per-command card. What a command may
 * touch is decided by the device's own Sandbox switch, which only the owner
 * sets, in Settings. Consent answers WHO, the sandbox answers WHAT. Folding
 * the two into one card is how the owner ended up being asked to approve
 * `rm -rf ~/work` at two in the morning, on a card whose only real choice was
 * whether to keep working.
 *
 * A prompt that nobody answered is neither answer. It used to resolve as
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

import type { DynamicApproval } from '../prompting/volatile-context';
import * as v from 'valibot';

/** How a consent prompt settled. `timeout` is NOT a decision — nobody made
 *  one. It is never remembered, and it never becomes a stored policy. */
export type DeviceConsentDecision = 'once' | 'always' | 'deny' | 'timeout';

/** What the owner can actually answer. `timeout` is not among them. */
export type DeviceConsentAnswer = Exclude<DeviceConsentDecision, 'timeout'>;

/** The owner said no. A policy decision: asking again immediately is noise. */
export const DEVICE_CONSENT_DENIED =
  'device use was not approved: the owner declined';

/** Nobody answered before the prompt expired. Deliberately worded so a model
 *  reading it cannot mistake it for a refusal: the capability is intact and
 *  the request is worth making again when someone is around. */
export const DEVICE_CONSENT_UNANSWERED =
  'device use is still unapproved: the consent prompt expired with no answer, so nobody decided. '
  + 'Continue without the device and ask again later.';

/** The pseudo-method a device request carries when there is no machine to
 *  act on yet — the card asks the owner to LINK one (the `kinu connect`
 *  flow) rather than to allow one action. Approval grants nothing by itself;
 *  execution stays impossible until a daemon is actually connected. */
export const DEVICE_PROVISION_METHOD = 'connect';

/**
 * What linking a machine means, in the words a person needs before they say
 * yes. Every connect surface states it BEFORE the daemon is installed: the
 * install is the moment an agent gains reach into that machine, and it must
 * never happen as a side effect of typing a command or clicking a button.
 *
 * It lives here because the CLI prints it and the web connect panel renders
 * it. Two copies of a consent disclosure is how the two of them start saying
 * different things about the same grant.
 */
export const DEVICE_CONNECT_DISCLOSURE: readonly string[] = [
  'Connecting installs the Kinu daemon on this machine and links it to your account.',
  'A workspace you approve runs commands in a sandbox: its own home plus folders you pick.',
  'Your other files stay invisible to it.',
  'You approve each workspace once. Revoke it under Account settings → Devices.',
  'That page has one Sandbox switch per device. Off means this whole machine, as your user.',
  'The daemon dials out and opens no inbound ports.',
];

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

/** What the agent is asking for: this workspace's use of this machine.
 *
 *  `method` and `command` say what the agent was doing when it first reached
 *  for the machine. They are context on the card, never the thing being
 *  approved — the answer binds the workspace to the device, not the command.
 *
 *  `workspaceName` names the workspace whose access is being decided when the
 *  caller is a workspace — the binding is per-(workspace, device), and a card
 *  that cannot say which workspace asks cannot be answered once with
 *  understanding. Absent for non-workspace callers. */
export interface DeviceConsentRequest {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly method: string;
  readonly command: string;
  readonly workspaceName?: string;
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
  /** Every caller waiting on this one prompt. An identical re-ask joins the
   *  list rather than raising a second card. */
  readonly awaiting: ((decision: DeviceConsentDecision) => void)[];
  readonly settle: (decision: DeviceConsentDecision) => void;
}

/**
 * A pending prompt has one capability context (device and workspace) and one
 * action (method and command) that raised it. A changed device label is
 * presentation metadata for that same device, not a new question for the
 * owner.
 */
function sameRequest(pending: DeviceConsentRequest, request: DeviceConsentRequest): boolean {
  if (
    pending.deviceId !== request.deviceId
    || pending.workspaceName !== request.workspaceName
  ) return false;
  return pending.method === request.method && pending.command === request.command;
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

  /** Raise a prompt and wait for it to settle. An identical prompt already
   *  waiting is JOINED, not raised again: one card, one answer, and every
   *  caller that asked settled by it. */
  request(req: DeviceConsentRequest): Promise<DeviceConsentDecision> {
    const { promise, resolve } = Promise.withResolvers<DeviceConsentDecision>();
    const already = this.pendingLike(req);
    if (already) {
      already.awaiting.push(resolve);
      return promise;
    }
    const consentId = this.deps.newId();
    const view: PendingDeviceConsent = { ...req, consentId, createdAt: this.now() };
    const awaiting = [resolve];
    const timer = setTimeout(() => {
      if (!this.waiting.delete(consentId)) return;
      this.deps.announce({ kind: 'settled', consentId });
      for (const settle of awaiting) settle('timeout');
    }, this.timeoutMs);
    this.waiting.set(consentId, {
      view,
      awaiting,
      settle: (decision) => {
        clearTimeout(timer);
        for (const settle of awaiting) settle(decision);
      },
    });
    // Announced only once the id can be answered: a surface that resolves
    // synchronously on the notice was otherwise told the id is unknown.
    this.deps.announce({ kind: 'raised', consent: view });
    return promise;
  }

  private pendingLike(req: DeviceConsentRequest): Waiting | undefined {
    for (const pending of this.waiting.values()) {
      if (sameRequest(pending.view, req)) return pending;
    }
    return undefined;
  }

  /** The owner answered. False when the id is unknown — already settled, or
   *  from a previous instance of this host. */
  resolve(consentId: string, decision: DeviceConsentAnswer): boolean {
    const pending = this.waiting.get(consentId);
    if (!pending) return false;
    this.waiting.delete(consentId);
    this.deps.announce({ kind: 'settled', consentId });
    // Anything unrecognised is the weakest grant, never a stronger one.
    const effective = decision === 'always' || decision === 'deny' ? decision : 'once';
    pending.settle(effective);
    if (effective === 'always') this.settleBoundByGrant(pending.view);
    return true;
  }

  /**
   * An "always" answer is a binding, and a binding decides more than the card
   * it was given on. Every other prompt still waiting for the same device AND
   * the same workspace is now answered, so leaving its card up asks the owner
   * to decide again what they just decided forever — the duplicate they see.
   * Those settle as `once`: the remembering is the one "always", never one per
   * card.
   *
   * The workspace has to match. A binding is per (workspace, device), so one
   * workspace's answer is not another's — a host that ever holds two
   * workspaces' prompts in one registry must not let the first one in on the
   * second one's card.
   */
  private settleBoundByGrant(granted: PendingDeviceConsent): void {
    // The provisioning card names no machine and binds nothing.
    if (!granted.deviceId) return;
    // Iterated directly: deleting the CURRENT key mid-iteration is defined
    // behaviour for a Map, and this loop deletes nothing else, so a snapshot
    // copy would buy nothing.
    for (const [consentId, pending] of this.waiting) {
      if (pending.view.deviceId !== granted.deviceId) continue;
      if (pending.view.workspaceName !== granted.workspaceName) continue;
      this.waiting.delete(consentId);
      this.deps.announce({ kind: 'settled', consentId });
      pending.settle('once');
    }
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
