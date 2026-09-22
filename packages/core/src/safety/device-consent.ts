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
 * A prompt that nobody answered is neither answer. Resolving it as `deny`
 * tells the model its request was refused when the owner was simply away from
 * the keyboard — and an agent meant to run for hours unattended reads a
 * refusal as policy and stops asking, turning a temporary absence into a
 * permanent capability loss. The two outcomes carry different words.
 *
 * The registry below is the waiting half: raise a prompt, park the caller on a
 * promise, and settle it when the owner answers or when the prompt expires.
 * The pending ask is a ROW, not process state — a Durable Object evicted or
 * redeployed between the ask and the answer loses its callers, never the card,
 * so the answer that arrives afterwards still lands on the question it was
 * meant for. What stays in memory is only who is waiting and when the prompt
 * lapses: resolvers and timers are per-activation and cannot outlive it.
 */

import type { DynamicApproval } from '../types/dynamic-context';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
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


/**
 * What linking a machine means, in the words a person needs before they say
 * yes — exactly three lines. Every connect surface states it BEFORE the
 * daemon is installed: the install is the moment an agent gains reach into
 * that machine, and it must never happen as a side effect of typing a
 * command or clicking a button.
 *
 * It lives here because the CLI prints it and the web connect panel renders
 * it. Two copies of a consent disclosure is how the two of them start saying
 * different things about the same grant.
 */
export const DEVICE_CONNECT_DISCLOSURE: readonly string[] = [
  'Kinu installs a small daemon here and links this machine to your account.',
  'A workspace you approve runs in a sandbox: its own home plus folders you pick. Everything else stays invisible to it.',
  'The daemon only dials out. Revoke it any time under Account settings → Devices.',
];

export interface DeviceActionSummary {
  method: string;
  command: string;
}

export function summarizeDeviceAction(method: string, params: unknown[]): DeviceActionSummary {
  // `exec`'s first param IS the command. Anything else there is a malformed
  // call, and is summarized the way every other method's params are.
  if (method === 'exec') {
    const first = params.at(0);
    const command = v.safeParse(v.string(), first ?? '');

    return { method, command: command.success ? command.output : summarizeParam({ value: first }) };
  }

  return {
    method,
    command: `${method}(${params.map((p) => summarizeParam({ value: p })).join(', ')})`,
  };
}

function summarizeParam(input: { value: unknown }): string {
  const text = v.safeParse(v.string(), input.value);
  // Everything that reaches here came off the wire as JSON, so JSON renders
  // it. Only an absent value has no rendering of its own.
  const rendered = text.success ? text.output : (JSON.stringify(input.value) ?? 'undefined');

  return rendered.slice(0, 120);
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
  /** Where a raised card lives until it settles. The registry keeps only who
   *  is waiting on it; the request itself is this row, durable across the
   *  host's own evictions. */
  store: DeviceConsentStore;
  /** How long an unanswered prompt waits before it expires. */
  timeoutMs?: number;
  now?: () => number;
}

/** How long an unanswered prompt waits by default. Long enough that a user who
 *  stepped away can still come back to it, short enough that a device call is
 *  never parked forever. */
export const DEVICE_CONSENT_TIMEOUT_MS = 5 * 60_000;

/** One pending prompt, durable. The request's own words plus the id the
 *  owner's answer addresses and the instant the ask stops counting — the row
 *  IS the card, so an activation that never saw the raise still owes the
 *  owner exactly this. */
export interface PendingConsentRow extends PendingDeviceConsent {
  readonly expiresAt: number;
}

/** The table the cards live in. One row per unanswered ask, keyed by the id
 *  the owner's click names. */
export function initDeviceConsentRequestsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS device_consent_requests (
    consent_id      TEXT PRIMARY KEY,
    device_id       TEXT NOT NULL,
    device_label    TEXT NOT NULL,
    method          TEXT NOT NULL,
    command         TEXT NOT NULL,
    workspace_name  TEXT,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL
  )`);
}

interface ConsentRow {
  consent_id: string;
  device_id: string;
  device_label: string;
  method: string;
  command: string;
  workspace_name: string | null;
  created_at: number;
  expires_at: number;
}

function toPending(r: ConsentRow): PendingConsentRow {
  const pending: PendingConsentRow = {
    consentId: r.consent_id,
    deviceId: r.device_id,
    deviceLabel: r.device_label,
    method: r.method,
    command: r.command,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };

  if (r.workspace_name !== null) return { ...pending, workspaceName: r.workspace_name };

  return pending;
}

/**
 * The durable half of a pending prompt: rows in `device_consent_requests`,
 * written when the card is raised and deleted when it settles — by answer or
 * by expiry. Every read sweeps lapsed rows first, so a prompt whose activation
 * died before its timer fired still reads expired, never as still waiting.
 */
export class DeviceConsentStore {
  constructor(private readonly sql: SqlExecutor) {}
  /** Every card still open, oldest first — raise order, so two asks stamped
   *  inside one clock tick still list in the order they went up. */
  live(now: number): PendingConsentRow[] {
    void this.sql`DELETE FROM device_consent_requests WHERE expires_at <= ${now}`;

    return this.sql<ConsentRow>`
      SELECT consent_id, device_id, device_label, method, command,
             workspace_name, created_at, expires_at
      FROM device_consent_requests ORDER BY created_at ASC, rowid ASC`.map(toPending);
  }

  /** The lapse half of a settle: the row goes, whatever the clock says. The
   *  only caller is the card's own timer, armed from this row's deadline, so
   *  its firing IS the lapse — and a same-tick answer already won the row
   *  through `take` first, leaving nothing here to delete. */
  remove(consentId: string): void {
    void this.sql`DELETE FROM device_consent_requests WHERE consent_id = ${consentId}`;
  }

  /** Write the card. Callers mint the id first, so the row exists under the
   *  exact key the announce about to go out tells surfaces to answer. */
  insert(row: PendingConsentRow): void {
    void this.sql`INSERT INTO device_consent_requests
      (consent_id, device_id, device_label, method, command, workspace_name, created_at, expires_at)
      VALUES (${row.consentId}, ${row.deviceId}, ${row.deviceLabel}, ${row.method},
        ${row.command}, ${row.workspaceName ?? null}, ${row.createdAt}, ${row.expiresAt})`;
  }

  /** Remove the card and hand back what it said — null when nothing by that
   *  id is still waiting (already settled, expired, or never raised on this
   *  object's storage). One row means one settle: a duplicate or late answer
   *  takes nothing and reports nothing. */
  take(consentId: string, now: number): PendingConsentRow | null {
    const rows = this.sql<ConsentRow>`
      DELETE FROM device_consent_requests
      WHERE consent_id = ${consentId} AND expires_at > ${now}
      RETURNING consent_id, device_id, device_label, method, command,
                workspace_name, created_at, expires_at`;

    return rows[0] ? toPending(rows[0]) : null;
  }
}

/**
 * The per-activation half of a waiting card: who is parked on it and when it
 * lapses. Both are property of THIS instance — a resolver is a closure and a
 * timer is a handle, and neither survives an eviction, so nothing here is the
 * request itself. The row is.
 */
interface Inflight {
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
  /** Who THIS activation has parked on each card, and the lapse timer armed
   *  for it. Subscribers only: an eviction empties the map and loses nobody's
   *  question, because the question is the store's row — a fresh instance
   *  re-parks callers onto rows it never raised. */
  private readonly inflight = new Map<string, Inflight>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DeviceConsentRegistryDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEVICE_CONSENT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Raise a prompt and wait for it to settle. An identical prompt already
   *  waiting is JOINED, not raised again: one card, one answer, and every
   *  caller that asked settled by it — including the card a previous
   *  activation left waiting, which reads as already up off its row. */
  request(req: DeviceConsentRequest): Promise<DeviceConsentDecision> {
    const { promise, resolve } = Promise.withResolvers<DeviceConsentDecision>();
    const already = this.deps.store.live(this.now()).find((pending) => sameRequest(pending, req));

    if (already) {
      this.parked(already).awaiting.push(resolve);

      return promise;
    }

    const consentId = this.deps.newId();
    const createdAt = this.now();
    const view: PendingDeviceConsent = { ...req, consentId, createdAt };
    // The row before the announce and the parking: the id a surface is told
    // about must be answerable from the moment the notice lands. The notice
    // itself stays the surface view — the deadline lives in the row, not the
    // card.
    const row: PendingConsentRow = { ...view, expiresAt: createdAt + this.timeoutMs };
    this.deps.store.insert(row);
    this.parked(row).awaiting.push(resolve);
    this.deps.announce({ kind: 'raised', consent: view });

    return promise;
  }

  /** The parked-callers entry for one card, minting one for a row this
   *  activation did not raise. The lapse timer arms off the ROW's deadline,
   *  not a fresh window from now: a prompt restored after an eviction keeps
   *  the expiry it was raised with rather than silently outliving it. */
  private parked(pending: PendingConsentRow): Inflight {
    const parked = this.inflight.get(pending.consentId);

    if (parked) return parked;

    const awaiting: Inflight['awaiting'] = [];

    const timer = setTimeout(
      () => this.expire(pending.consentId),
      Math.max(0, pending.expiresAt - this.now()),
    );

    const entry: Inflight = {
      awaiting,
      settle: (decision) => {
        clearTimeout(timer);

        for (const resolve of awaiting) resolve(decision);
      },
    };

    this.inflight.set(pending.consentId, entry);

    return entry;
  }

  /** The card lapsed with no answer. Reachable only through a parked entry's
   *  own timer, armed from the row's deadline — so the row goes with the
   *  timer, and surfaces hear `settled` exactly as an answered card does. */
  private expire(consentId: string): void {
    const entry = this.inflight.get(consentId);
    this.inflight.delete(consentId);
    this.deps.store.remove(consentId);
    this.deps.announce({ kind: 'settled', consentId });
    entry?.settle('timeout');
  }

  /** The owner answered. False when the id is unknown — already settled, or
   *  never raised on this object's storage. */
  resolve(consentId: string, decision: DeviceConsentAnswer): boolean {
    const pending = this.deps.store.take(consentId, this.now());

    if (!pending) return false;
    this.deps.announce({ kind: 'settled', consentId });
    // Anything unrecognised is the weakest grant, never a stronger one.
    const effective = decision === 'always' || decision === 'deny' ? decision : 'once';
    const entry = this.inflight.get(consentId);
    this.inflight.delete(consentId);
    entry?.settle(effective);

    if (effective === 'always') this.settleBoundByGrant(pending);

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
    for (const pending of this.deps.store.live(this.now())) {
      if (pending.deviceId !== granted.deviceId) continue;

      if (pending.workspaceName !== granted.workspaceName) continue;

      if (this.deps.store.take(pending.consentId, this.now()) === null) continue;
      const entry = this.inflight.get(pending.consentId);
      this.inflight.delete(pending.consentId);
      this.deps.announce({ kind: 'settled', consentId: pending.consentId });
      entry?.settle('once');
    }
  }

  /** Everything still waiting — so a client that reloaded, or an activation
   *  that never saw the raise, re-renders its cards. */
  list(): PendingDeviceConsent[] {
    return this.deps.store.live(this.now()).map(({ expiresAt: _expiresAt, ...view }) => view);
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
