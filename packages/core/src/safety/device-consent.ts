import { markStoreChanged } from '@kinu.run/agent-utils';
/**
 * Device binding, asked once per (workspace, device), and the asks parked on the owner meanwhile. Consent answers who;
 * the device's Sandbox switch answers what. An ask parks as a deferred approval does (deferred-approval.ts): the call
 * that raised it is NOT RUN at once, the owner's answer wakes the actor that asked, and its re-issue runs on that
 * answer. No ask lapses: nothing measured says how long an owner takes, and an unanswered ask is no answer.
 */

import type { DynamicApproval } from '../types/dynamic-context';
import { InvocationSurfaceSchema, resumedSurfaceMetadata, type InvocationSurface } from '../types/jobs';
import type { SqlExecutor } from '../types/primitives';
import type { AgentSignal } from '../types/signals';
import { diagnostics, renderThrownChain, settle, type ErrorCode, type KinuError } from '../obs/index';
import { DENIAL_STANDING_MS } from './deferred-approval';
import { Effect, Result } from 'effect';
import * as v from 'valibot';
import { SEALABLE_FOLDERS } from '../execution/run-later-paths';

/** What the owner can answer. Only `always` is remembered, as the workspace's binding to the device. */
export type DeviceConsentAnswer = 'once' | 'always' | 'deny';

const DEVICE_CONSENT_DENIED =
  'device use was not approved: the owner declined';

/** A call whose approval was given under an epoch a revocation has since ended: nothing ran, and nobody refused it. */
export function deviceConsentMoved(deviceLabel: string): string {
  return `access to ${deviceLabel} changed while this call waited for its approval, so nothing ran. Run it again to ask.`;
}

/** Worded so a model cannot mistake an unasked owner for a refusal: the capability is intact. */
const DEVICE_CONSENT_UNANSWERED =
  'device use is still unapproved: the consent prompt could not be raised, so nobody decided. '
  + 'Continue without the device and ask again later.';

/** The call that raised an ask, or re-issued one still waiting: nothing ran, and the owner's answer wakes the asker. */
function deviceConsentQueued(deviceLabel: string): string {
  return `NOT RUN: using ${deviceLabel} from this workspace waits on the owner's consent. `
    + 'You are woken when they answer; do not re-issue it before then.';
}

/** A connect is done when the device the hub issued for it is connected: the one rule the browser's panel and
 *  `kinu connect` both read, never "some device arrived". */
export function issuedDeviceConnected<Device extends { readonly id: string; readonly connected: boolean }>(
  devices: readonly Device[], deviceId: string,
): Device | undefined {
  return devices.find((device) => device.id === deviceId && device.connected);
}

/**
 * What sharing the home folder lets a sandboxed command change, said once (owner decision 2026-10-22): everything but
 * the declared run-later paths (run-later-paths.ts), with plainly that the list cannot be complete, and the folders a
 * missing one closes to new entries.
 */
export const HOME_FOLDER_CONSENT = 'If you pick your home folder, the agent can change files in it, except the ones your '
  + 'computer runs later outside the sandbox: shell startup files, ~/.local/bin and ~/bin, autostart and login items, '
  + 'SSH and git settings, package-manager settings and editor plugins. That list cannot be complete, so pick a project '
  + `folder if you want nothing else in reach. Where one of those files does not exist yet, its folder (${SEALABLE_FOLDERS.join(', ')}) `
  + 'takes no new files or folders directly in it; new work goes inside an existing folder.';

/** Stated by every connect surface before the daemon is installed; one copy shared by CLI and web. */
export const DEVICE_CONNECT_DISCLOSURE: readonly string[] = [
  'Kinu installs a small daemon here and links this machine to your account.',
  'A workspace you approve runs in a sandbox: its own home plus folders you pick. Everything else stays invisible to it.',
  HOME_FOLDER_CONSENT,
  'The daemon only dials out. Revoke it any time under Account settings > Devices.',
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
 *  `workspaceName` is absent for non-workspace callers; `actorId`, for a call no agent made (the owner's own), which
 *  an answer wakes nobody for. */
export interface DeviceConsentRequest {
  readonly deviceId: string;
  readonly deviceLabel: string;
  readonly method: string;
  readonly command: string;
  readonly workspaceName?: string;
  readonly actorId?: string;
  /** The hub's grant epoch the call is made under, which every revocation advances: an approval given under an
   *  earlier one answers none of the calls made under a later one. */
  readonly epoch: number;
  /** The surface of the turn the call was made in, which set its background policy: the re-issue an answer wakes for
   *  is the same call, and runs under it. Absent for a caller with no turn. */
  readonly surface?: InvocationSurface;
}

/** Carries the id the answer addresses, so a reloaded client can re-render its cards. */
export interface PendingDeviceConsent extends Omit<DeviceConsentRequest, 'actorId' | 'epoch' | 'surface'> {
  readonly consentId: string;
  readonly createdAt: number;
}

/** A pending consent as a client reads it over the wire. */
export const PendingDeviceConsentSchema: v.GenericSchema<PendingDeviceConsent> = v.object({
  consentId: v.string(),
  deviceId: v.string(),
  deviceLabel: v.string(),
  method: v.string(),
  command: v.string(),
  workspaceName: v.optional(v.string()),
  createdAt: v.number(),
});

/** An owner's answer to a consent, as a client reads its receipt: false when nothing waited on it. */
export const ResolvedDeviceConsentSchema = v.object({ ok: v.boolean() });

export type DeviceConsentNotice =
  | { readonly kind: 'raised'; readonly consent: PendingDeviceConsent }
  | { readonly kind: 'settled'; readonly consentId: string };

/** What an ask answers its call: run on an answer the call spends (`always` is also bound by the caller), refused on a
 *  standing denial, or NOT RUN while the owner has yet to answer. */
export type DeviceConsentVerdict = 'once' | 'always' | 'denied' | 'queued';

export interface DeviceConsentRegistryDeps {
  announce(notice: DeviceConsentNotice): void;
  /** Injected so hosts keep their own id vocabulary and tests are deterministic. */
  newId(): string;
  /** The asks themselves live here, durable across host evictions. */
  store: DeviceConsentStore;
  /** Wakes the actor an answer is for, as a deferred approval's decision does. */
  wake(actorId: string, signal: AgentSignal): Effect.Effect<void, KinuError>;
  now?: () => number;
}

/** The `kinuEvent` kind an answer wakes its asker under. */
const DEVICE_CONSENT_SIGNAL = 'device_consent';

type DeviceConsentStatus = 'queued' | DeviceConsentAnswer;

/** One ask: the card while it waits, then the owner's answer until the call it answers spends it. */
export interface DeviceConsentAsk extends PendingDeviceConsent {
  readonly actorId?: string;
  readonly epoch: number;
  readonly surface?: InvocationSurface;
  readonly status: DeviceConsentStatus;
  readonly decidedAt: number | null;
}

/** A `device` row of `owner_requests` (safety/owner-requests.ts). */
interface AskRow {
  id: string;
  actor_id: string | null;
  device_id: string;
  device_label: string;
  method: string;
  command: string;
  workspace_name: string | null;
  requested_at: number;
  epoch: number;
  status: string;
  decided_at: number | null;
  surface: string | null;
}

const StatusSchema = v.picklist(['queued', 'once', 'always', 'deny']);

function toAsk(r: AskRow): DeviceConsentAsk {
  return {
    consentId: r.id,
    deviceId: r.device_id,
    deviceLabel: r.device_label,
    method: r.method,
    command: r.command,
    createdAt: r.requested_at,
    epoch: r.epoch,
    status: v.parse(StatusSchema, r.status),
    decidedAt: r.decided_at,
    ...(r.workspace_name !== null && { workspaceName: r.workspace_name }),
    ...(r.actor_id !== null && { actorId: r.actor_id }),
    ...(r.surface !== null && { surface: v.parse(InvocationSurfaceSchema, r.surface) }),
  };
}

/** The card a client renders: the ask without its answer. */
function pendingOf(ask: DeviceConsentAsk): PendingDeviceConsent {
  const { status: _status, decidedAt: _decidedAt, actorId: _actorId, epoch: _epoch, surface: _surface, ...pending } = ask;

  return pending;
}

/** The `device` rows of `owner_requests`: one per ask, kept until the call it answers spends it, or a denial has stood
 *  its {@link DENIAL_STANDING_MS}. */
export class DeviceConsentStore {
  constructor(private readonly sql: SqlExecutor) {}

  /** Waiting asks, oldest first, in raise order, so asks within one clock tick keep their order. A retired agent's
   *  would answer nobody: it can neither be told nor re-issue; the owner's own stand. */
  queued(): DeviceConsentAsk[] {
    return this.sql<AskRow>`
      SELECT c.* FROM owner_requests c LEFT JOIN workspace_actors a ON a.actor_id = c.actor_id
      WHERE c.kind = 'device' AND c.status = 'queued'
        AND (c.actor_id IS NULL OR (a.retiring_at IS NULL AND a.deleted_at IS NULL AND a.actor_id IS NOT NULL))
      ORDER BY c.requested_at ASC, c.rowid ASC`.map(toAsk);
  }

  /** The newest ask of exactly this request, an approval only from its own epoch; a changed device label is
   *  presentation metadata, not a new question. */
  standing(req: DeviceConsentRequest): DeviceConsentAsk | null {
    const [row] = this.sql<AskRow>`
      SELECT * FROM owner_requests
      WHERE kind = 'device' AND device_id = ${req.deviceId} AND workspace_name IS ${req.workspaceName ?? null} AND actor_id IS ${req.actorId ?? null}
        AND method = ${req.method} AND command = ${req.command}
        AND (status IN ('queued', 'deny') OR epoch = ${req.epoch})
      ORDER BY requested_at DESC, rowid DESC LIMIT 1`;

    return row === undefined ? null : toAsk(row);
  }

  insert(ask: DeviceConsentAsk): void {
    void this.sql`INSERT INTO owner_requests
      (kind, id, actor_id, device_id, device_label, method, command, workspace_name, requested_at, epoch, status, decided_at, surface)
      VALUES ('device', ${ask.consentId}, ${ask.actorId ?? null}, ${ask.deviceId}, ${ask.deviceLabel}, ${ask.method},
        ${ask.command}, ${ask.workspaceName ?? null}, ${ask.createdAt}, ${ask.epoch}, ${ask.status}, ${ask.decidedAt}, ${ask.surface ?? null})`;
    markStoreChanged(this.sql);
  }

  /** The owner's answer on a waiting ask; null when nothing by that id waits. One row means one answer. */
  decide(consentId: string, answer: DeviceConsentAnswer, now: number): DeviceConsentAsk | null {
    const [row] = this.sql<AskRow>`
      UPDATE owner_requests SET status = ${answer}, decided_at = ${now}
      WHERE kind = 'device' AND id = ${consentId} AND status = 'queued' RETURNING *`;

    if (row !== undefined) markStoreChanged(this.sql);

    return row === undefined ? null : toAsk(row);
  }

  /** The call an approval answers spends it, under the epoch it was given in: whether this call won the row. */
  spend(consentId: string, epoch: number): boolean {
    const spent = this.sql<{ id: string }>`
      DELETE FROM owner_requests WHERE kind = 'device' AND id = ${consentId} AND status IN ('once', 'always') AND epoch = ${epoch}
      RETURNING id`;

    if (spent.length > 0) markStoreChanged(this.sql);

    return spent.length > 0;
  }

  /** Denials that have stood their time, and approvals a revocation since made void; nothing else sweeps them. */
  sweep(now: number, epoch: number): void {
    void this.sql`DELETE FROM owner_requests WHERE kind = 'device'
      AND ((status = 'deny' AND decided_at <= ${now - DENIAL_STANDING_MS}) OR (status IN ('once', 'always') AND epoch < ${epoch}))`;
  }
}

/** The message on the turn an answer wakes: one for the asks answered together. */
function answerWakeMessage(answered: readonly DeviceConsentAsk[]): string {
  const lines: string[] = [];

  const section = (title: string, asks: readonly DeviceConsentAsk[]): void => {
    if (asks.length > 0) lines.push(title, ...asks.map((ask) => `  ${ask.deviceLabel}: ${ask.command}`));
  };

  // Repeat "still not run": the exact mistake an agent makes on waking.
  section('Device use APPROVED, still not run: re-issue once:', answered.filter((ask) => ask.status !== 'deny'));
  section('Device use DENIED: do not re-issue:', answered.filter((ask) => ask.status === 'deny'));

  return lines.join('\n');
}

/** The asks parked on the owner for a workspace's device calls, and the answers waiting on the calls they answer. */
export class DeviceConsentRegistry {
  private readonly now: () => number;

  constructor(private readonly deps: DeviceConsentRegistryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * What `req` may do now: spend an answer its ask holds, stand refused on a denial, or park, joining the identical
   * ask already waiting (one card, one answer) or raising its own. A re-issue before the answer is the same ask.
   */
  ask(req: DeviceConsentRequest): DeviceConsentVerdict {
    const now = this.now();
    this.deps.store.sweep(now, req.epoch);
    const standing = this.deps.store.standing(req);

    if (standing?.status === 'queued') return 'queued';

    if (standing?.status === 'deny') return 'denied';

    // A concurrent re-issue may win the row; this one then asks afresh.
    if (standing !== null && this.deps.store.spend(standing.consentId, req.epoch)) return standing.status === 'always' ? 'always' : 'once';
    const ask: DeviceConsentAsk = { ...req, consentId: this.deps.newId(), createdAt: now, status: 'queued', decidedAt: null };
    // Row before announce: the id a surface hears about must be answerable when the notice lands.
    this.deps.store.insert(ask);
    this.deps.announce({ kind: 'raised', consent: pendingOf(ask) });

    return 'queued';
  }

  /**
   * The owner's answer; false when nothing by that id waits. An `always` also answers every other ask waiting on that
   * device for that workspace (bindings are per workspace and device). Each asker is woken once, with its own.
   */
  resolve(consentId: string, answer: DeviceConsentAnswer): Promise<boolean> {
    const now = this.now();
    // Anything unrecognised is the weakest grant, never a stronger one.
    const effective = answer === 'always' || answer === 'deny' ? answer : 'once';
    const decided = this.deps.store.decide(consentId, effective, now);

    if (decided === null) return Promise.resolve(false);

    const covered = effective !== 'always' ? [] : this.deps.store.queued()
      .filter((ask) => ask.deviceId === decided.deviceId && ask.workspaceName === decided.workspaceName)
      .flatMap((ask) => this.deps.store.decide(ask.consentId, 'always', now) ?? []);

    const answered = [decided, ...covered];

    for (const ask of answered) this.deps.announce({ kind: 'settled', consentId: ask.consentId });

    return settle(Effect.flatMap(this.wake(answered), (results) => {
      const [failed] = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));

      return failed === undefined ? Effect.succeed(true) : Effect.fail(failed);
    }));
  }

  /** Each asker once, every one tried: the answers are already durable, and one asker's failed wake is no reason
   *  another goes untold. The failures are the answer's, after. */
  private wake(answered: readonly DeviceConsentAsk[]) {
    const askers = new Set(answered.flatMap((ask) => ask.actorId ?? []));

    return Effect.forEach(askers, (actorId) => {
      const own = answered.filter((ask) => ask.actorId === actorId);

      return Effect.result(this.deps.wake(actorId, {
        kind: DEVICE_CONSENT_SIGNAL,
        text: answerWakeMessage(own),
        // How many were approved and denied, for the person's card: the text is the agent's.
        metadata: {
          ids: own.map((ask) => ask.consentId),
          approved: own.filter((ask) => ask.status !== 'deny').length,
          denied: own.filter((ask) => ask.status === 'deny').length,
          ...resumedSurfaceMetadata(own.filter((ask) => ask.status !== 'deny').map((ask) => ask.surface)),
        },
      }));
    });
  }

  list(): PendingDeviceConsent[] {
    return this.deps.store.queued().map(pendingOf);
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

/** A workspace's standing binding to a device: allowed, refused, or none, so an ask decides. */
export type DeviceBinding = 'allow' | 'deny' | null;

/** A device call's consent: run, or the refusal its caller answers with, in its code and words. */
export type DeviceConsentOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: Extract<ErrorCode, 'denied' | 'unavailable'>; readonly reason: string };

const REFUSED: DeviceConsentOutcome = { allowed: false, code: 'denied', reason: DEVICE_CONSENT_DENIED };

/**
 * The binding rule, both halves: a standing binding decides without asking; otherwise the ask does. An `always` its
 * call spends is bound (`bind`), so later calls run on the binding; `once` runs this call alone. A parked ask is NOT
 * RUN, a did-not-start code, as is an ask that could not be raised: nobody was asked, so it is no refusal. `bind`
 * answers false when a revocation ended the epoch the ask was made under while it was out: that approval answers
 * nothing, and the call, not run, asks again.
 */
export function deviceConsentOutcome(input: {
  readonly bound: DeviceBinding;
  readonly deviceLabel: string;
  readonly ask: Effect.Effect<DeviceConsentVerdict, KinuError>;
  readonly bind: Effect.Effect<boolean, KinuError>;
}): Effect.Effect<DeviceConsentOutcome, KinuError> {
  if (input.bound === 'allow') return Effect.succeed({ allowed: true });

  if (input.bound === 'deny') return Effect.succeed(REFUSED);

  return Effect.flatMap(Effect.result(input.ask), (asked): Effect.Effect<DeviceConsentOutcome, KinuError> => {
    if (Result.isFailure(asked)) {
      diagnostics.event('device.consent_unreachable', { error: renderThrownChain({ cause: asked.failure }) });

      return Effect.succeed({ allowed: false, code: 'unavailable', reason: DEVICE_CONSENT_UNANSWERED });
    }

    const verdict = asked.success;

    if (verdict === 'denied') return Effect.succeed(REFUSED);

    if (verdict === 'queued') return Effect.succeed({ allowed: false, code: 'unavailable', reason: deviceConsentQueued(input.deviceLabel) });

    if (verdict === 'once') return Effect.succeed({ allowed: true });

    return Effect.map(input.bind, (bound): DeviceConsentOutcome => (bound
      ? { allowed: true }
      : { allowed: false, code: 'unavailable', reason: deviceConsentMoved(input.deviceLabel) }));
  });
}
