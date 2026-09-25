/**
 * Device binding, asked once per (workspace, device), plus the registry of prompts awaiting an answer.
 * Consent answers who; the device's Sandbox switch answers what. An unanswered prompt is neither answer.
 * The pending ask is a durable row; only resolvers and timers are per-activation.
 */

import type { DynamicApproval } from '../types/dynamic-context';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import * as v from 'valibot';

/** `timeout` is not a decision: never remembered, never stored as policy. */
export type DeviceConsentDecision = 'once' | 'always' | 'deny' | 'timeout';

export type DeviceConsentAnswer = Exclude<DeviceConsentDecision, 'timeout'>;

export const DEVICE_CONSENT_DENIED =
  'device use was not approved: the owner declined';

/** Worded so a model cannot mistake expiry for refusal: the capability is intact. */
export const DEVICE_CONSENT_UNANSWERED =
  'device use is still unapproved: the consent prompt expired with no answer, so nobody decided. '
  + 'Continue without the device and ask again later.';

/** Stated by every connect surface before the daemon is installed; one copy shared by CLI and web. */
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
  // `exec`'s first param is the command; anything else is summarized like other params.
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
  const rendered = text.success ? text.output : (JSON.stringify(input.value) ?? 'undefined');

  return rendered.slice(0, 120);
}

/** `method`/`command` are context on the card; the answer binds the workspace to the device, not the command.
 *  `workspaceName` is absent for non-workspace callers. */
export interface DeviceConsentRequest {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly method: string;
  readonly command: string;
  readonly workspaceName?: string;
}

/** Carries the id the answer addresses, so a reloaded client can re-render its cards. */
export interface PendingDeviceConsent extends DeviceConsentRequest {
  readonly consentId: string;
  readonly createdAt: number;
}

export type DeviceConsentNotice =
  | { readonly kind: 'raised'; readonly consent: PendingDeviceConsent }
  | { readonly kind: 'settled'; readonly consentId: string };

export interface DeviceConsentRegistryDeps {
  announce(notice: DeviceConsentNotice): void;
  /** Injected so hosts keep their own id vocabulary and tests are deterministic. */
  newId(): string;
  /** The request itself lives here, durable across host evictions. */
  store: DeviceConsentStore;
  timeoutMs?: number;
  now?: () => number;
}

const DEVICE_CONSENT_TIMEOUT_MS = 5 * 60_000;

/** The row is the card, so an activation that never saw the raise still owes the owner this. */
export interface PendingConsentRow extends PendingDeviceConsent {
  readonly expiresAt: number;
}

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

/** Rows in `device_consent_requests`. Every read sweeps lapsed rows first, so a dead activation's prompt reads expired. */
export class DeviceConsentStore {
  constructor(private readonly sql: SqlExecutor) {}
  /** Oldest first, in raise order, so asks within one clock tick keep their order. */
  live(now: number): PendingConsentRow[] {
    void this.sql`DELETE FROM device_consent_requests WHERE expires_at <= ${now}`;

    return this.sql<ConsentRow>`
      SELECT consent_id, device_id, device_label, method, command,
             workspace_name, created_at, expires_at
      FROM device_consent_requests ORDER BY created_at ASC, rowid ASC`.map(toPending);
  }

  /** Only caller is the card's own timer; a same-tick answer already won the row through `take`. */
  remove(consentId: string): void {
    void this.sql`DELETE FROM device_consent_requests WHERE consent_id = ${consentId}`;
  }

  /** Callers mint the id first, so the row exists under the key the announce names. */
  insert(row: PendingConsentRow): void {
    void this.sql`INSERT INTO device_consent_requests
      (consent_id, device_id, device_label, method, command, workspace_name, created_at, expires_at)
      VALUES (${row.consentId}, ${row.deviceId}, ${row.deviceLabel}, ${row.method},
        ${row.command}, ${row.workspaceName ?? null}, ${row.createdAt}, ${row.expiresAt})`;
  }

  /** Null when nothing by that id is waiting. One row means one settle. */
  take(consentId: string, now: number): PendingConsentRow | null {
    const rows = this.sql<ConsentRow>`
      DELETE FROM device_consent_requests
      WHERE consent_id = ${consentId} AND expires_at > ${now}
      RETURNING consent_id, device_id, device_label, method, command,
                workspace_name, created_at, expires_at`;

    return rows[0] ? toPending(rows[0]) : null;
  }
}

/** Per-activation half of a waiting card; neither resolvers nor timers survive eviction. */
interface Inflight {
  /** An identical re-ask joins the list rather than raising a second card. */
  readonly awaiting: ((decision: DeviceConsentDecision) => void)[];
  readonly settle: (decision: DeviceConsentDecision) => void;
}

/** A changed device label is presentation metadata, not a new question. */
function sameRequest(pending: DeviceConsentRequest, request: DeviceConsentRequest): boolean {
  if (
    pending.deviceId !== request.deviceId
    || pending.workspaceName !== request.workspaceName
  ) return false;

  return pending.method === request.method && pending.command === request.command;
}

/** `request` resolves on an answer, or as `timeout` when nobody answers. */
export class DeviceConsentRegistry {
  /** Subscribers only: a fresh instance re-parks callers onto rows it never raised. */
  private readonly inflight = new Map<string, Inflight>();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DeviceConsentRegistryDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEVICE_CONSENT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** An identical waiting prompt, including one a previous activation left, is joined, not raised again. */
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
    // Row before announce: the id a surface hears about must be answerable when the notice lands.
    const row: PendingConsentRow = { ...view, expiresAt: createdAt + this.timeoutMs };
    this.deps.store.insert(row);
    this.parked(row).awaiting.push(resolve);
    this.deps.announce({ kind: 'raised', consent: view });

    return promise;
  }

  /** The lapse timer arms off the row's deadline, so a restored prompt keeps its original expiry. */
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

  /** Reachable only through a parked entry's own timer; surfaces hear `settled` as for an answer. */
  private expire(consentId: string): void {
    const entry = this.inflight.get(consentId);
    this.inflight.delete(consentId);
    this.deps.store.remove(consentId);
    this.deps.announce({ kind: 'settled', consentId });
    entry?.settle('timeout');
  }

  /** False when the id is unknown: already settled, or never raised on this storage. */
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

  /** An "always" settles every other waiting prompt for the same device and workspace as `once`.
   *  The workspace must match: bindings are per (workspace, device). */
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

  list(): PendingDeviceConsent[] {
    return this.deps.store.live(this.now()).map(({ expiresAt: _expiresAt, ...view }) => view);
  }

  /** Lets the agent tell a gated action stuck on the human from one that failed. */
  approvals(): DynamicApproval[] {
    return this.list().map((c) => ({
      id: c.consentId,
      kind: 'device consent',
      detail: `${c.deviceLabel}: ${c.command}`,
    }));
  }
}
