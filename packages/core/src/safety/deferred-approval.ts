/**
 * Deferred approval: a gated action parks on the owner instead of blocking or being auto-denied, and
 * the agent is told it is parked. Honesty invariant: a queued action returns through `denyResult`, so a
 * success-shaped result for an action that did not run is unreachable; 'approved' is permission, not an
 * effect; parked actions are re-stated every step. The queue is SQL because it must survive eviction.
 */

import type { DynamicApproval } from '../types/dynamic-context';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { AgentInbox } from '../types/signals';
import type { ApprovalConsumedRecord } from '../events/types';
import * as v from 'valibot';
import {
  formatApproval, gatedGrants, reviewCommand,
  type ApprovalGrant, type ApprovalSpend, type ApprovalSpendOutcome,
  type DeferredApprovalChannel, type ShellApprovalRequest,
} from './approval-gate';
import { nanoid } from '../utils/nanoid';
import { diagnostics, toKinuError } from '../obs/index';

/** The `kinuEvent` kind a decision wakes the agent under; same mechanism as the background-job wake. */
export const DEFERRED_APPROVAL_SIGNAL = 'deferred_approval';

/** Where a parked action is. No "executed" state: this queue records permission, not effects. */
export type DeferredApprovalStatus =
  /** Parked on the owner. Nobody has decided. */
  | 'queued'
  /** The owner said yes. The command has not run; the grant is unspent. */
  | 'approved'
  /** The owner said no. Stands for {@link DENIAL_STANDING_MS}, then is swept. */
  | 'denied'
  /** The grant is out with a running command and answers nobody. The gate deletes the row or restores
   *  'approved'; a row left here means a process died mid-command, and the grant is lost (safe direction). */
  | 'spent';

/** What the owner can pick. `always` is `approved` plus a standing grant for the tripped rules on that executor. */
export type DeferredApprovalAnswer = Extract<DeferredApprovalStatus, 'approved' | 'denied'> | 'always';

/** How long a denial answers before the queue asks again. Denied rows expire so old refusals
 *  don't govern today and don't accumulate; standing policy lives in actor_config. */
export const DENIAL_STANDING_MS = 24 * 60 * 60 * 1000;

/** One action parked on the owner. */
export interface DeferredApproval {
  readonly id: string;
  /** The exact command the agent asked to run. */
  readonly command: string;
  /** The machine it was bound for; a grant for one executor never answers for another. */
  readonly executor: string;
  /** Why the gate stopped it — `formatApproval` of the review that fired. */
  readonly reason: string;
  readonly status: DeferredApprovalStatus;
  readonly requestedAt: number;
  /** When the owner answered, or null while it is still parked. */
  readonly decidedAt: number | null;
}

/** What the gate learns about a command. `shell` is the only verdict that proceeds, and reaching it
 *  has already spent the grant; it names the spend so the gate can close it. */
export type DeferredApprovalVerdict =
  | { readonly outcome: 'run'; readonly action: DeferredApproval; readonly spend: ApprovalSpend }
  | { readonly outcome: 'denied'; readonly action: DeferredApproval }
  | { readonly outcome: 'queued'; readonly action: DeferredApproval };

interface Row {
  id: string; command: string; executor: string; reason: string; status: string;
  requested_at: number; decided_at: number | null;
}

/** A row plus which spend of it is being reported. */
interface SpendRow extends Row { spend_seq: number }

function toAction(r: Row): DeferredApproval {
  const status = v.safeParse(v.picklist(['queued', 'approved', 'denied', 'spent']), r.status);

  return {
    id: r.id,
    command: r.command,
    executor: r.executor,
    reason: r.reason,
    status: status.success ? status.output : 'queued',
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
  };
}

/** Spend counter; a settle names its spend so a late or replayed settle cannot reopen a later grant. */
export function initDeferredApprovalsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS deferred_approvals (
    actor_id     TEXT NOT NULL,
    id           TEXT NOT NULL,
    command      TEXT NOT NULL,
    executor     TEXT NOT NULL DEFAULT '',
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    requested_at INTEGER NOT NULL,
    decided_at   INTEGER,
    spend_seq    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (actor_id, id)
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_deferred_approvals_status
    ON deferred_approvals(actor_id, status, requested_at)`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_deferred_approvals_command
    ON deferred_approvals(actor_id, command, executor, requested_at DESC)`);
}

/** The durable rows; pure storage. */
export class DeferredApprovalStore {
  private readonly actorId: string;

  /** Bind the table to one actor: grants and denials never cross actors. */
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle) {
    this.actorId = actor.actorId;
  }

  /** The live row for this command on this executor: 'queued', 'approved', or a still-standing 'denied'.
   *  'spent' is excluded. A decision outranks a pending ask; among decisions the newest wins. */
  standing(command: string, executor: string, now: number): DeferredApproval | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`
      SELECT id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals
      WHERE actor_id = ${this.actorId} AND command = ${command} AND executor = ${executor}
        AND (status IN ('queued','approved')
          OR (status = 'denied' AND decided_at > ${now - DENIAL_STANDING_MS}))
      ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, requested_at DESC
      LIMIT 1`;

    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Delete expired denials (run on write paths); returns the count deleted. */
  sweepDenials(now: number): number {
    this.actor.assertCurrent();

    return this.sql<{ id: string }>`
      DELETE FROM deferred_approvals
      WHERE actor_id = ${this.actorId} AND status = 'denied'
        AND decided_at <= ${now - DENIAL_STANDING_MS}
      RETURNING id`.length;
  }

  create(action: Omit<DeferredApproval, 'status' | 'decidedAt'>): DeferredApproval {
    this.actor.assertCurrent();
    void this.sql`INSERT INTO deferred_approvals
        (actor_id, id, command, executor, reason, status, requested_at, decided_at)
      VALUES (${this.actorId}, ${action.id}, ${action.command}, ${action.executor}, ${action.reason},
        'queued', ${action.requestedAt}, NULL)`;

    return { ...action, status: 'queued', decidedAt: null };
  }

  /** Record the owner's answer; reports the row only if this call changed it. Read and write have no
   *  await between them, which is atomic on single-threaded SQLite. */
  decide(id: string, answer: DeferredApprovalAnswer, now: number): DeferredApproval | null {
    this.actor.assertCurrent();

    if (this.get(id)?.status !== 'queued') return null;
    // The row only holds statuses about this one command; 'always' grants are recorded by the queue.
    const status = answer === 'always' ? 'approved' : answer;
    void this.sql`UPDATE deferred_approvals SET status=${status}, decided_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='queued'`;

    return this.get(id);
  }

  /** Hand an approved grant to a command about to run. It leaves `standing()` before the command runs,
   *  so a crash loses an approval rather than granting twice. Returns null if another call won. */
  spend(id: string): { readonly action: DeferredApproval; readonly spend: ApprovalSpend } | null {
    this.actor.assertCurrent();

    const rows = this.sql<SpendRow>`
      UPDATE deferred_approvals SET status='spent', spend_seq = spend_seq + 1
      WHERE actor_id = ${this.actorId} AND id = ${id} AND status = 'approved'
      RETURNING id, command, executor, reason, status, requested_at, decided_at, spend_seq`;

    const row = rows[0];

    if (!row) return null;

    return {
      action: toAction(row),
      spend: { approvalId: row.id, spend: row.spend_seq },
    };
  }

  /** Close a spend: consume the grant or give it back. Guarded on the spend counter, so it is
   *  idempotent and a stale settle cannot reach a later attempt. Reports whether this call moved the row. */
  settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome): boolean {
    this.actor.assertCurrent();

    const rows = outcome === 'did-not-run'
      ? this.sql<{ id: string }>`
          UPDATE deferred_approvals SET status='approved'
          WHERE actor_id = ${this.actorId} AND id = ${spent.approvalId}
            AND status='spent' AND spend_seq = ${spent.spend}
          RETURNING id`
      : this.sql<{ id: string }>`
          DELETE FROM deferred_approvals
          WHERE actor_id = ${this.actorId} AND id = ${spent.approvalId}
            AND status='spent' AND spend_seq = ${spent.spend}
          RETURNING id`;

    return rows.length > 0;
  }

  get(id: string): DeferredApproval | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`
      SELECT id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE actor_id = ${this.actorId} AND id = ${id} LIMIT 1`;

    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Everything still parked on the owner, oldest first. */
  listQueued(limit = 100): DeferredApproval[] {
    this.actor.assertCurrent();

    return this.sql<Row>`
      SELECT id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE actor_id = ${this.actorId} AND status='queued'
      ORDER BY requested_at ASC LIMIT ${limit}`.map(toAction);
  }
}

/** How much of a command the roster lines quote. */
const COMMAND_ECHO_MAX_CHARS = 160;

function clip(text: string): string {
  return text.length <= COMMAND_ECHO_MAX_CHARS ? text : `${text.slice(0, COMMAND_ECHO_MAX_CHARS)}…`;
}

/** The one-line result for a parked action: nothing ran, which rule, which machine, and the id.
 *  Standing doctrine lives in the system prompt. Still returned through `denyResult`. */
function queuedActionMessage(action: DeferredApproval): string {
  return `NOT RUN — queued for owner approval (${action.id}): ${ruleNames(action)} on ${action.executor}. `
    + 'A decision will wake you.';
}

/** Result for re-issuing a refused command; mirrors safety/device-consent.ts. */
function deniedActionMessage(action: DeferredApproval): string {
  return `NOT RUN — the owner refused this (${action.id}). Not a timeout; find another way.`;
}

/** The rules the review named, for a one-line result; full prose is in `action.reason`. */
function ruleNames(action: DeferredApproval): string {
  const names = [...action.reason.matchAll(/^• ([\w-]+) \(/gm)].map((m) => m[1]);

  return names.length > 0 ? names.join(', ') : 'needs approval';
}

/** The message on the turn a decision wakes: one for the whole batch. */
function decisionWakeMessage(decided: readonly DeferredApproval[]): string {
  const lines: string[] = [];
  const approved = decided.filter((a) => a.status === 'approved');
  const denied = decided.filter((a) => a.status === 'denied');

  // Repeat "still not run": the exact mistake an agent makes on waking.
  if (approved.length > 0) {
    lines.push('APPROVED, still not run — re-issue once:',
      ...approved.map((a) => `  ${a.id} — ${clip(a.command)}`));
  }

  if (denied.length > 0) {
    lines.push('DENIED — do not re-issue:',
      ...denied.map((a) => `  ${a.id} — ${clip(a.command)}`));
  }

  return lines.join('\n');
}

export interface DeferredApprovalQueueDeps {
  readonly store: DeferredApprovalStore;
  /** The one way anything asynchronous reaches the agent, same as a settled background job. */
  readonly inbox: AgentInbox;
  /** Record a standing grant from an 'always' answer; the host owns storage (actor_config). */
  remember(grants: readonly ApprovalGrant[]): void;
  /** Durable audit sink for `approval_consumed`. Optional only for tests; production must wire it. */
  audit?(record: ApprovalConsumedRecord): void;
  /** Mint a request id; injected for host id vocabulary and deterministic tests. */
  newId?: () => string;
  now?: () => number;
  /** Told when actions park and batches are decided. Never throws into the gate. */
  announce?(event: DeferredApprovalNotice): void;
}

/** What the host is told as actions come and go. */
export type DeferredApprovalNotice =
  | { readonly kind: 'queued'; readonly action: DeferredApproval }
  | { readonly kind: 'decided'; readonly actions: readonly DeferredApproval[] };

export class DeferredApprovalQueue {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: DeferredApprovalQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `defer-${nanoid(10)}`);
  }

  /** The gate's view: run, or the words to hand the model, plus the way back for an unused spend. */
  get channel(): DeferredApprovalChannel {
    return {
      park: (req) => {
        const verdict = this.park(req);

        if (verdict.outcome === 'run') return { run: true, spent: verdict.spend };

        return {
          run: false,
          // A parked action is an absence of decision, not a refusal: the owner can still approve it.
          reason: verdict.outcome === 'denied' ? 'denied' : 'unavailable',
          message: verdict.outcome === 'denied'
            ? deniedActionMessage(verdict.action)
            : queuedActionMessage(verdict.action),
        };
      },
      settle: (spent, outcome) => { this.settle(spent, outcome); },
    };
  }

  /** Park an action, or answer with the owner's standing decision. Re-asking returns the same row
   *  so the turn's repeat detector (orchestrator/turn-steering.ts) sees a loop. */
  park(req: ShellApprovalRequest): DeferredApprovalVerdict {
    const now = this.now();
    // Delete expired denials on the write path; nothing else sweeps them.
    this.deps.store.sweepDenials(now);
    const standing = this.deps.store.standing(req.command, req.executor, now);

    if (standing?.status === 'denied') return { outcome: 'denied', action: standing };

    if (standing?.status === 'approved') {
      // Spend before running so a crash loses an approval rather than granting twice.
      const spent = this.deps.store.spend(standing.id);

      if (spent) return { outcome: 'run', action: spent.action, spend: spent.spend };
      // Lost the race to a concurrent re-issue: fall through and park again.
    }

    if (standing?.status === 'queued') return { outcome: 'queued', action: standing };

    const action = this.deps.store.create({
      id: this.newId(),
      command: req.command,
      executor: req.executor,
      reason: formatApproval(req.review),
      requestedAt: now,
    });

    this.notify({ kind: 'queued', action });

    return { outcome: 'queued', action };
  }

  /** Close a spend {@link park} made. 'spent' consumes the grant and writes the `approval_consumed`
   *  audit; 'did-not-run' restores the row and writes nothing. Reports whether this call closed it. */
  settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome): boolean {
    const action = this.deps.store.get(spent.approvalId);

    if (!this.deps.store.settle(spent, outcome)) return false;

    if (outcome === 'spent' && action) {
      try {
        this.deps.audit?.({
          approvalId: action.id, command: action.command, executor: action.executor,
        });
      } catch (cause) {
        diagnostics.failure('approval.audit_emit_failed', toKinuError({
          doing: 'recording an approval_consumed run event', cause, otherwise: 'io',
        }));
      }
    }

    return true;
  }

  /** The owner decided, for one or many actions. `always` also remembers the tripped rules on that
   *  executor. Rows are written before the one wake signal. */
  async decide(ids: readonly string[], answer: DeferredApprovalAnswer): Promise<DeferredApproval[]> {
    const now = this.now();
    this.deps.store.sweepDenials(now);
    const decided: DeferredApproval[] = [];

    // Deduped so one command is not reported as two decisions.
    for (const id of new Set(ids)) {
      const action = this.deps.store.decide(id, answer, now);

      if (action) decided.push(action);
    }

    if (decided.length === 0) return decided;

    if (answer === 'always') {
      // Recomputed, not stored: the rule table is the source of truth.
      this.deps.remember(decided.flatMap(
        (a) => gatedGrants(reviewCommand(a.command, a.executor), a.executor)));
    }

    this.notify({ kind: 'decided', actions: decided });
    await this.deps.inbox.send({
      kind: DEFERRED_APPROVAL_SIGNAL,
      text: decisionWakeMessage(decided),
      metadata: { decision: answer, count: decided.length, ids: decided.map((a) => a.id) },
    });

    return decided;
  }

  /** Everything still parked, oldest first. */
  list(): DeferredApproval[] {
    return this.deps.store.listQueued();
  }

  /** Parked actions for the per-step dynamic-context block, re-telling the turn they have not run. */
  approvals(): DynamicApproval[] {
    return this.list().map((action) => ({
      id: action.id,
      kind: 'queued command (NOT run)',
      detail: clip(action.command),
    }));
  }

  private notify(event: DeferredApprovalNotice): void {
    try { this.deps.announce?.(event); }
    catch (err) {
      diagnostics.failure(
        'approval.deferred_announce_failed',
        toKinuError({ doing: 'announce a deferred-approval notice', cause: err, otherwise: 'io' }),
        { notice: event.kind },
      );
    }
  }
}

/** The owner's decision as both backends answer it: the ids it moved. */
export async function decideDeferredApprovals(
  queue: DeferredApprovalQueue, ids: readonly string[], answer: DeferredApprovalAnswer,
): Promise<{ decided: string[] }> {
  const decided = await queue.decide(ids, answer);

  return { decided: decided.map((action) => action.id) };
}
