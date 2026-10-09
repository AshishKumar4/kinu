import { markStoreChanged } from '@kinu.run/agent-utils';
/**
 * Deferred approval: a gated action parks on the owner and the agent is told so. A queued action returns through
 * `denyResult`, so nothing unrun looks like a success; 'approved' is permission, not an effect, except a parked
 * write's. SQL, to survive eviction.
 */

import type { DynamicApproval } from '../types/dynamic-context';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import type { AgentSignal } from '../types/signals';
import type { ApprovalConsumedRecord } from '../events/types';
import * as v from 'valibot';
import {
  formatApproval,
  type ApprovalGrant,
  type ApprovalSpend,
  type ApprovalSpendOutcome,
  type DeferredApprovalChannel,
  type ShellApprovalRequest,
} from './approval-gate';
import { boundWriteOf, type ApprovalContent, type BoundFileWrite } from './bound-write';
import { nanoid } from '../utils/nanoid';
import { diagnostics, KinuError, settle, settleLoggedSync, toKinuError } from '../obs/index';
import { Effect } from 'effect';
import { serialQueue } from '@kinu.run/agent-utils';

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
  /** Out with a running command, answering nobody; left here, its process died mid-command and the grant is lost. */
  | 'spent';

/** What the owner can pick. `always` is `approved` plus a standing grant for the tripped rules on that executor. */
export type DeferredApprovalAnswer = Extract<DeferredApprovalStatus, 'approved' | 'denied'> | 'always';

/** How long a denial answers before the queue asks again; standing policy lives in actor_config. */
export const DENIAL_STANDING_MS = 24 * 60 * 60 * 1000;

/** One action parked on the owner. */
export interface DeferredApproval {
  readonly id: string;
  /** The actor that asked, by id: its approvals and denials stand for it alone, and the decision wakes it. */
  readonly actor: string;
  /** The exact command the agent asked to run. */
  readonly command: string;
  /** The machine it was bound for; a grant for one executor never answers for another. */
  readonly executor: string;
  /** Why the gate stopped it — `formatApproval` of the review that fired. */
  readonly reason: string;
  readonly status: DeferredApprovalStatus;
  readonly requestedAt: number;
  readonly decidedAt: number | null;
}

/** What the gate learns about a command; `run` has already spent the grant and names the spend. */
export type DeferredApprovalVerdict =
  | { readonly outcome: 'run'; readonly action: DeferredApproval; readonly spend: ApprovalSpend }
  | { readonly outcome: 'denied'; readonly action: DeferredApproval }
  | { readonly outcome: 'queued'; readonly action: DeferredApproval };

interface Row {
  actor_id: string; id: string; command: string; executor: string; reason: string; status: string;
  requested_at: number; decided_at: number | null;
}

/** A row plus which spend of it is being reported. */
interface SpendRow extends Row { spend_seq: number }

function toAction(r: Row): DeferredApproval {
  const status = v.safeParse(v.picklist(['queued', 'approved', 'denied', 'spent']), r.status);

  return {
    id: r.id,
    actor: r.actor_id,
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
  // The tripped rules as data: `reason` is display text.
  execRaw(`CREATE TABLE IF NOT EXISTS deferred_approval_hits (
    actor_id    TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    rule        TEXT NOT NULL,
    decision    TEXT NOT NULL,
    PRIMARY KEY (actor_id, approval_id, rule)
  )`);
}

export interface DeferredApprovalHit {
  readonly rule: string;
  readonly decision: string;
}

/** The durable rows; pure storage. */
export class DeferredApprovalStore {
  /** The actor whose rows these are. */
  readonly actorId: string;

  /**
   * Bind the table to one actor's rows: grants and denials never cross actors. `rowsOf`: a hired agent's rows, kept in
   * the storage `actor` owns, as the one queue of its workspace keeps them ({@link forActor}).
   */
  constructor(private readonly sql: SqlExecutor, private readonly actor: ActorHandle, rowsOf: string = actor.actorId) {
    this.actorId = rowsOf;
  }

  /** Another actor's rows in the same storage: a hire's, in its root's. */
  forActor(actorId: string): DeferredApprovalStore {
    return new DeferredApprovalStore(this.sql, this.actor, actorId);
  }

  /** Every actor's rows still parked on the owner, oldest first: the workspace's one queue. */
  workspaceQueued(limit = 100): DeferredApproval[] {
    this.actor.assertCurrent();

    return this.sql<Row>`
      SELECT actor_id, id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE status='queued'
      ORDER BY requested_at ASC LIMIT ${limit}`.map(toAction);
  }

  /** The actors with a row of this id: ids are minted unique, so one. */
  owners(id: string): string[] {
    this.actor.assertCurrent();

    return this.sql<{ actor_id: string }>`SELECT actor_id FROM deferred_approvals WHERE id = ${id}`.map((row) => row.actor_id);
  }

  /** Whether any actor's live row names these bytes: parked bytes are the workspace's, whoever parked them. */
  namesBytes(sha256: string): boolean {
    this.actor.assertCurrent();

    return this.sql<{ id: string }>`
      SELECT id FROM deferred_approvals
      WHERE status IN ('queued','approved') AND instr(command, ${` sha256:${sha256} over sha256:`}) > 0
      LIMIT 1`.length > 0;
  }

  /** This command's live row on this executor, never 'spent'; a decision outranks an ask, the newest wins. */
  standing(command: string, executor: string, now: number): DeferredApproval | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`
      SELECT actor_id, id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals
      WHERE actor_id = ${this.actorId} AND command = ${command} AND executor = ${executor}
        AND (status IN ('queued','approved')
          OR (status = 'denied' AND decided_at > ${now - DENIAL_STANDING_MS}))
      ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, requested_at DESC
      LIMIT 1`;

    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Delete expired denials (run on write paths); returns their commands. */
  sweepDenials(now: number): string[] {
    this.actor.assertCurrent();

    const swept = this.sql<{ id: string; command: string }>`
      DELETE FROM deferred_approvals
      WHERE actor_id = ${this.actorId} AND status = 'denied'
        AND decided_at <= ${now - DENIAL_STANDING_MS}
      RETURNING id, command`;

    if (swept.length > 0) markStoreChanged(this.sql);

    for (const { id } of swept) this.dropHits(id);

    return swept.map((row) => row.command);
  }

  create(action: Omit<DeferredApproval, 'actor' | 'status' | 'decidedAt'>, hits: readonly DeferredApprovalHit[]): DeferredApproval {
    this.actor.assertCurrent();
    void this.sql`INSERT INTO deferred_approvals
        (actor_id, id, command, executor, reason, status, requested_at, decided_at)
      VALUES (${this.actorId}, ${action.id}, ${action.command}, ${action.executor}, ${action.reason},
        'queued', ${action.requestedAt}, NULL)`;
    markStoreChanged(this.sql);

    for (const hit of hits) {
      void this.sql`INSERT OR IGNORE INTO deferred_approval_hits (actor_id, approval_id, rule, decision)
        VALUES (${this.actorId}, ${action.id}, ${hit.rule}, ${hit.decision})`;
    }

    return { ...action, actor: this.actorId, status: 'queued', decidedAt: null };
  }

  hits(id: string): DeferredApprovalHit[] {
    this.actor.assertCurrent();

    return this.sql<DeferredApprovalHit>`
      SELECT rule, decision FROM deferred_approval_hits
      WHERE actor_id = ${this.actorId} AND approval_id = ${id}
      ORDER BY rule`;
  }

  private dropHits(id: string): void {
    void this.sql`DELETE FROM deferred_approval_hits WHERE actor_id = ${this.actorId} AND approval_id = ${id}`;
  }

  /** The owner's answer; the row only if this call changed it. No await between read and write: atomic here. */
  decide(id: string, answer: DeferredApprovalAnswer, now: number): DeferredApproval | null {
    this.actor.assertCurrent();

    if (this.get(id)?.status !== 'queued') return null;
    // The row only holds statuses about this one command; 'always' grants are recorded by the queue.
    const status = answer === 'always' ? 'approved' : answer;
    void this.sql`UPDATE deferred_approvals SET status=${status}, decided_at=${now}
      WHERE actor_id=${this.actorId} AND id=${id} AND status='queued'`;
    markStoreChanged(this.sql);

    return this.get(id);
  }

  /** Hands an approved grant to a command about to run, out of `standing()` first: a crash loses it, never doubles
   *  it; null if another call won. */
  spend(id: string): { readonly action: DeferredApproval; readonly spend: ApprovalSpend } | null {
    this.actor.assertCurrent();

    const rows = this.sql<SpendRow>`
      UPDATE deferred_approvals SET status='spent', spend_seq = spend_seq + 1
      WHERE actor_id = ${this.actorId} AND id = ${id} AND status = 'approved'
      RETURNING actor_id, id, command, executor, reason, status, requested_at, decided_at, spend_seq`;

    if (rows.length > 0) markStoreChanged(this.sql);

    const row = rows[0];

    if (!row) return null;

    return {
      action: toAction(row),
      spend: { approvalId: row.id, spend: row.spend_seq },
    };
  }

  /** Consumes the grant or gives it back, guarded on the spend counter; whether the row moved. */
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

    if (rows.length > 0) markStoreChanged(this.sql);

    if (outcome === 'spent') for (const { id } of rows) this.dropHits(id);

    return rows.length > 0;
  }

  get(id: string): DeferredApproval | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`
      SELECT actor_id, id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE actor_id = ${this.actorId} AND id = ${id} LIMIT 1`;

    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Everything still parked on the owner, oldest first. */
  listQueued(limit = 100): DeferredApproval[] {
    this.actor.assertCurrent();

    return this.sql<Row>`
      SELECT actor_id, id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE actor_id = ${this.actorId} AND status='queued'
      ORDER BY requested_at ASC LIMIT ${limit}`.map(toAction);
  }
}

/** How much of a command the roster lines quote. */
const COMMAND_ECHO_MAX_CHARS = 160;

function clip(text: string): string {
  return text.length <= COMMAND_ECHO_MAX_CHARS ? text : `${text.slice(0, COMMAND_ECHO_MAX_CHARS)}...`;
}

/** A parked action's one-line result, returned through `denyResult`: nothing ran, which rule and machine, the id. */
function queuedActionMessage(action: DeferredApproval, hits: readonly DeferredApprovalHit[]): string {
  return `NOT RUN: queued for owner approval (${action.id}): ${ruleNames(hits)} on ${action.executor}. `
    + 'A decision will wake you.';
}

/** Result for re-issuing a refused command; mirrors safety/device-consent.ts. */
function deniedActionMessage(action: DeferredApproval): string {
  return `NOT RUN: the owner refused this (${action.id}). Not a timeout; find another way.`;
}

/** The rules the review named, for a one-line result; full prose is in `action.reason`. */
function ruleNames(hits: readonly DeferredApprovalHit[]): string {
  return hits.length > 0 ? hits.map((hit) => hit.rule).join(', ') : 'needs approval';
}

type WriteOutcome = 'written' | 'changed';

/** Where parked writes keep their bytes, and how an approved one lands. */
export interface ParkedWrites {
  readonly content: ApprovalContent;
  perform(write: BoundFileWrite, bytes: Uint8Array): Promise<WriteOutcome>;
}

function boundBytes(commands: readonly string[]): string[] {
  return commands.flatMap((command) => boundWriteOf(command)?.next ?? []);
}

/** The message on the turn a decision wakes: one for the whole batch. */
function decisionWakeMessage(decided: readonly DeferredApproval[], written: ReadonlyMap<string, WriteOutcome>): string {
  const lines: string[] = [];

  const section = (title: string, actions: readonly DeferredApproval[]): void => {
    if (actions.length > 0) lines.push(title, ...actions.map((a) => `  ${a.id}: ${clip(a.command)}`));
  };

  section('WRITTEN on approval: nothing to re-issue:', decided.filter((a) => written.get(a.id) === 'written'));
  section('APPROVED, not written: the file changed since the ask; read it again:', decided.filter((a) => written.get(a.id) === 'changed'));
  // Repeat "still not run": the exact mistake an agent makes on waking.
  section('APPROVED, still not run: re-issue once:', decided.filter((a) => a.status === 'approved' && !written.has(a.id)));
  section('DENIED: do not re-issue:', decided.filter((a) => a.status === 'denied'));

  return lines.join('\n');
}

export interface DeferredApprovalQueueDeps {
  /** The root's rows: the queue's owner, whose storage holds every actor's ({@link DeferredApprovalStore.forActor}). */
  readonly store: DeferredApprovalStore;
  /**
   * Wakes the actor a decision answers: the root through its inbox, a hired agent through its own durable turn. The
   * one way anything asynchronous reaches an agent, as a settled background job does.
   */
  wake(actorId: string, signal: AgentSignal): Effect.Effect<void, KinuError>;
  /** Record a standing grant from an 'always' answer; the host owns storage (actor_config). */
  remember(grants: readonly ApprovalGrant[]): void;
  /** Durable `approval_consumed` sink; optional only for tests. */
  audit?(record: ApprovalConsumedRecord): void;
  /** Mint a request id; injected for host id vocabulary and deterministic tests. */
  newId?: () => string;
  now?: () => number;
  /** Told when actions park and batches are decided. Never throws into the gate. */
  announce?(event: DeferredApprovalNotice): void;
  /**
   * The root's approved parked write runs on approval; failing, its row stays approved for a re-issue. A hired agent's
   * is approved and re-issued by the agent, under its own credential: the root's would stand in for it. Null: nothing
   * parks a write.
   */
  readonly writes: ParkedWrites | null;
}

/** What the host is told as actions come and go. */
export type DeferredApprovalNotice =
  | { readonly kind: 'queued'; readonly action: DeferredApproval }
  | { readonly kind: 'decided'; readonly actions: readonly DeferredApproval[] };

/**
 * A workspace's one queue of actions parked on its owner. Each actor parks through its own channel, so its rows, and
 * the approvals and denials that stand on them, are its own; the owner sees and decides them all in one list.
 */
export class DeferredApprovalQueue {
  private readonly now: () => number;
  private readonly newId: () => string;
  /** Bytes a park is keeping before its row names them. */
  private readonly parking = new Map<string, number>();
  /** One at a time, so a delete's check sees every keep queued before it. */
  private readonly serial = serialQueue();
  private readonly stores = new Map<string, DeferredApprovalStore>();

  constructor(private readonly deps: DeferredApprovalQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `defer-${nanoid(10)}`);
  }

  private storeOf(actorId: string): DeferredApprovalStore {
    const held = this.stores.get(actorId) ?? this.deps.store.forActor(actorId);

    this.stores.set(actorId, held);

    return held;
  }

  /** The root's own channel. */
  get channel(): DeferredApprovalChannel {
    return this.channelFor(this.deps.store.actorId);
  }

  /** The gate's view for one actor: run, or the words to hand the model, plus the way back for an unused spend. */
  channelFor(actorId: string): DeferredApprovalChannel {
    return {
      park: async (req) => {
        const verdict = await this.park(req, actorId);

        if (verdict.outcome === 'run') return { run: true, spent: verdict.spend };

        return {
          run: false,
          // A parked action is an absence of decision, not a refusal: the owner can still approve it.
          reason: verdict.outcome === 'denied' ? 'denied' : 'unavailable',
          message: verdict.outcome === 'denied'
            ? deniedActionMessage(verdict.action)
            : queuedActionMessage(verdict.action, this.storeOf(actorId).hits(verdict.action.id)),
        };
      },
      settle: async (spent, outcome) => { await this.settle(spent, outcome, actorId); },
    };
  }

  /** Parks an action or answers with the owner's standing decision; a re-ask returns the same row, so the turn's
   *  repeat detector sees a loop. A write's bytes are kept first, then held until its row names them. */
  async park(req: ShellApprovalRequest, actorId: string = this.deps.store.actorId): Promise<DeferredApprovalVerdict> {
    const { writes } = this.deps;
    const digest = boundWriteOf(req.command)?.next;
    const next = req.write?.next;

    if (writes === null || digest === undefined || next === undefined) return await this.parkNow(req, actorId);
    this.parking.set(digest, (this.parking.get(digest) ?? 0) + 1);

    try {
      await this.serial(() => writes.content.retain(next));

      return await this.parkNow(req, actorId);
    } finally {
      const holds = (this.parking.get(digest) ?? 1) - 1;

      if (holds === 0) this.parking.delete(digest);
      else this.parking.set(digest, holds);
      await this.release([digest]);
    }
  }

  private async parkNow(req: ShellApprovalRequest, actorId: string): Promise<DeferredApprovalVerdict> {
    const now = this.now();
    const store = this.storeOf(actorId);
    // Delete expired denials on the write path; nothing else sweeps them.
    const swept = store.sweepDenials(now);
    const verdict = this.answer(req, now, store);
    await this.release(boundBytes(swept));

    return verdict;
  }

  private answer(req: ShellApprovalRequest, now: number, store: DeferredApprovalStore): DeferredApprovalVerdict {
    const standing = store.standing(req.command, req.executor, now);

    if (standing?.status === 'denied') return { outcome: 'denied', action: standing };

    if (standing?.status === 'approved') {
      // Spend before running so a crash loses an approval rather than granting twice.
      const spent = store.spend(standing.id);

      if (spent) return { outcome: 'run', action: spent.action, spend: spent.spend };
      // Lost the race to a concurrent re-issue: fall through and park again.
    }

    if (standing?.status === 'queued') return { outcome: 'queued', action: standing };

    const action = store.create({
      id: this.newId(),
      command: req.command,
      executor: req.executor,
      reason: formatApproval(req.review),
      requestedAt: now,
    }, req.review.hits.map(({ rule, decision }) => ({ rule, decision })));

    this.notify({ kind: 'queued', action });

    return { outcome: 'queued', action };
  }

  /** Closes a spend: 'spent' consumes and audits the grant, 'did-not-run' restores the row; whether this call closed it. */
  async settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome, actorId: string = this.deps.store.actorId): Promise<boolean> {
    const store = this.storeOf(actorId);
    const action = store.get(spent.approvalId);

    if (!store.settle(spent, outcome)) return false;

    if (outcome === 'spent' && action) {
      this.audit(action);
      // A re-issued write ran on its own bytes, so the parked copy goes.
      await this.release(boundBytes([action.command]));
    }

    return true;
  }

  private audit(action: DeferredApproval): void {
    settleLoggedSync('approval.audit_emit_failed', { doing: 'recording an approval_consumed run event', otherwise: 'io' }, () => {
      this.deps.audit?.({
        approvalId: action.id, command: action.command, executor: action.executor,
      });
    });
  }

  /** Deletes the bytes no queued or approved row names and no park is holding. */
  private async release(digests: readonly string[]): Promise<void> {
    const content = this.deps.writes?.content;

    for (const digest of content === undefined ? [] : new Set(digests)) {
      const [deleted] = await Promise.allSettled([this.serial(async () => {
        if (!this.parking.has(digest) && !this.deps.store.namesBytes(digest)) await content?.delete(digest);
      })]);

      if (deleted.status === 'rejected') {
        diagnostics.failure('approval.parked_bytes_delete_failed', toKinuError({ doing: 'deleting a parked write\'s bytes', cause: deleted.reason, otherwise: 'io' }));
      }
    }
  }

  /**
   * The owner decided on one or many actions, whoever asked; `always` also grants the tripped rules on that executor.
   * Each asking actor is woken once, with its own.
   */
  async decide(ids: readonly string[], answer: DeferredApprovalAnswer): Promise<DeferredApproval[]> {
    const now = this.now();
    const decided: DeferredApproval[] = [];
    const swept: string[] = [];

    // Deduped so one command is not reported as two decisions.
    for (const id of new Set(ids)) {
      for (const actorId of this.deps.store.owners(id)) {
        const store = this.storeOf(actorId);
        swept.push(...store.sweepDenials(now));
        const action = store.decide(id, answer, now);

        if (action) decided.push(action);
      }
    }

    await this.release(boundBytes([...swept, ...decided.filter((a) => a.status === 'denied').map((a) => a.command)]));

    if (decided.length === 0) return decided;

    if (answer === 'always') {
      // Not re-reviewed: that would lose the call's member and cwd.
      this.deps.remember(decided.flatMap((a) => this.storeOf(a.actor).hits(a.id)
        .filter((hit) => hit.decision === 'gate').map((hit) => ({ rule: hit.rule, executor: a.executor }))));
    }

    const written = await this.performWrites(decided.filter((a) => a.actor === this.deps.store.actorId));
    this.notify({ kind: 'decided', actions: decided });

    // Each asker once, in turn: a wake that fails is the answer's failure, as the decision itself is already durable.
    const wakes = Effect.forEach(new Set(decided.map((a) => a.actor)), (actorId) => {
      const own = decided.filter((a) => a.actor === actorId);

      return this.deps.wake(actorId, {
        kind: DEFERRED_APPROVAL_SIGNAL,
        text: decisionWakeMessage(own, written),
        metadata: { decision: answer, count: own.length, ids: own.map((a) => a.id) },
      });
    }, { discard: true });

    return settle(Effect.as(wakes, decided));
  }

  /** The bytes are read while the approved row still names them, then the row is spent, so a re-issue meanwhile
   *  cannot write twice. */
  private async performWrites(decided: readonly DeferredApproval[]): Promise<ReadonlyMap<string, WriteOutcome>> {
    const written = new Map<string, WriteOutcome>();
    const { writes } = this.deps;
    const store = this.storeOf(this.deps.store.actorId);

    for (const action of writes === null ? [] : decided) {
      const write = action.status === 'approved' ? boundWriteOf(action.command) : null;

      if (write === null || writes === null) continue;

      const [read] = await Promise.allSettled([writes.content.read(write.next)]);
      const spent = store.spend(action.id);

      if (spent === null) continue;
      const bytes = read.status === 'fulfilled' ? read.value : null;
      const [performed] = bytes === null ? [null] : await Promise.allSettled([writes.perform(write, bytes)]);

      if (performed === null || performed.status === 'rejected') {
        store.settle(spent.spend, 'did-not-run');
        const cause = performed?.reason ?? (read.status === 'rejected' ? read.reason : new KinuError('missing', 'the parked bytes are gone'));
        diagnostics.failure('approval.write_failed', toKinuError({ doing: `writing ${write.path} on approval`, cause, otherwise: 'io' }));
        continue;
      }

      const outcome = performed.value;
      store.settle(spent.spend, 'spent');

      if (outcome === 'written') this.audit(spent.action);
      written.set(action.id, outcome);
      await this.release([write.next]);
    }

    return written;
  }

  /** A queued write's change, whoever parked it. */
  async parkedWrite(id: string): Promise<{ readonly write: BoundFileWrite; readonly bytes: Uint8Array } | null> {
    const action = this.deps.store.owners(id).map((actorId) => this.storeOf(actorId).get(id)).find((row) => row?.status === 'queued');
    const write = action === undefined || action === null ? null : boundWriteOf(action.command);
    const bytes = write === null ? null : await this.deps.writes?.content.read(write.next) ?? null;

    return write === null || bytes === null ? null : { write, bytes };
  }

  /** Everything still parked in the workspace, oldest first, each with the actor that asked. */
  list(): DeferredApproval[] {
    return this.deps.store.workspaceQueued();
  }

  /** One actor's parked actions for its per-step dynamic-context block, re-telling the turn they have not run. */
  approvals(actorId: string = this.deps.store.actorId): DynamicApproval[] {
    return this.storeOf(actorId).listQueued().map((action) => ({
      id: action.id,
      kind: 'queued command (NOT run)',
      detail: clip(action.command),
    }));
  }

  private notify(event: DeferredApprovalNotice): void {
    settleLoggedSync('approval.deferred_announce_failed', { doing: 'announce a deferred-approval notice', otherwise: 'io' }, () => {
      this.deps.announce?.(event);
    }, { notice: event.kind });
  }
}

/** The owner's decision as both backends answer it: the ids it moved. */
export async function decideDeferredApprovals(
  queue: DeferredApprovalQueue, ids: readonly string[], answer: DeferredApprovalAnswer,
): Promise<{ decided: string[] }> {
  const decided = await queue.decide(ids, answer);

  return { decided: decided.map((action) => action.id) };
}
