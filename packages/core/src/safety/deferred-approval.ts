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
  describeExecutionContext,
  executionContextKey,
  ExecutionContextSchema,
  formatApproval,
  gatedGrants,
  type ExecutionContext,
  type ApprovalGrant,
  type ApprovalSpend,
  type ApprovalSpendOutcome,
  type DeferredApprovalChannel,
  type ShellApprovalOutcome,
  type ShellApprovalRequest,
} from './approval-gate';
import type { ApprovalContent, BoundFileWrite } from './bound-write';
import { approvalKindOf, slateEffectExecutor, slateEffectText, type ApprovalKind, type SlateEffect } from './approval-kind';
import { nanoid } from '../utils/nanoid';
import { parseJsonValue } from '../utils/json';
import { diagnostics, KinuError, settle, settleLoggedSync, toKinuError } from '../obs/index';
import { Effect, Result } from 'effect';
import { serialQueue } from '@kinu.run/agent-utils';

/** The `kinuEvent` kind a decision wakes the agent under; same mechanism as the background-job wake. */
export const DEFERRED_APPROVAL_SIGNAL = 'deferred_approval';

/** Where a parked action is. No "executed" state: this queue records permission, not effects. */
type DeferredApprovalStatus =
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

/** A live prompt's answer, as the queue records it. */
const ANSWER_OF = { allow: 'approved', allow_always: 'always', deny: 'denied' } as const satisfies Record<ShellApprovalOutcome, DeferredApprovalAnswer>;

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
  /**
   * Where and how it runs there, as the gate resolved it; empty when the command says it all (a file access names its
   * path). Part of the ask: an approval runs this command in this context only, and the same words elsewhere are
   * another ask.
   */
  readonly context: ExecutionContext;
  /** Why the gate stopped it — `formatApproval` of the review that fired. */
  readonly reason: string;
  readonly status: DeferredApprovalStatus;
  readonly requestedAt: number;
  readonly decidedAt: number | null;
}

const DeferredApprovalStatusSchema = v.picklist(['queued', 'approved', 'denied', 'spent']);

/** A parked action as a surface across a wire reads it: the cloud terminal asks its workspace for the queue. */
export const DeferredApprovalSchema = v.object({
  id: v.string(), actor: v.string(), command: v.string(), executor: v.string(), context: ExecutionContextSchema, reason: v.string(),
  status: DeferredApprovalStatusSchema, requestedAt: v.number(), decidedAt: v.nullable(v.number()),
}) satisfies v.GenericSchema<DeferredApproval>;

/** What the gate learns about a command; `run` has already spent the grant and names the spend. */
export type DeferredApprovalVerdict =
  | { readonly outcome: 'run'; readonly action: DeferredApproval; readonly spend: ApprovalSpend }
  | { readonly outcome: 'denied'; readonly action: DeferredApproval }
  | { readonly outcome: 'queued'; readonly action: DeferredApproval };

/** A shared slate's effect, as its owner's queue answers it ({@link DeferredApprovalQueue.slateEffect}). */
export type SlateEffectVerdict =
  /** The owner approved this exact call; it is taken where the call is sent ({@link DeferredApprovalQueue.takeSlateEffect}). */
  | { readonly outcome: 'approved' }
  | { readonly outcome: 'asked'; readonly action: DeferredApproval }
  | { readonly outcome: 'denied'; readonly action: DeferredApproval };

/** A row another ask of the same command already ran on: the owner's one approval is used. */
interface UsedApproval {
  readonly outcome: 'used';
  readonly id: string;
}

interface Row {
  actor_id: string; id: string; command: string; executor: string; context: string; reason: string; status: string;
  requested_at: number; decided_at: number | null;
}

/** A row plus which spend of it is being reported. */
interface SpendRow extends Row { spend_seq: number }

function toAction(r: Row): DeferredApproval {
  const status = v.safeParse(DeferredApprovalStatusSchema, r.status);

  return {
    id: r.id,
    actor: r.actor_id,
    command: r.command,
    executor: r.executor,
    // Only `executionContextKey` writes the column.
    context: v.parse(ExecutionContextSchema, parseJsonValue(r.context)),
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
    context      TEXT NOT NULL DEFAULT '{}',
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
    ON deferred_approvals(actor_id, command, executor, context, requested_at DESC)`);
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

  /**
   * Every live actor's rows still parked on the owner, oldest first: the workspace's one queue. A retired agent's
   * would answer nobody: it can neither be told nor re-issue.
   */
  workspaceQueued(limit = 100): DeferredApproval[] {
    this.actor.assertCurrent();

    return this.sql<Row>`
      SELECT d.actor_id, d.id, d.command, d.executor, d.context, d.reason, d.status, d.requested_at, d.decided_at
      FROM deferred_approvals d JOIN workspace_actors a ON a.actor_id = d.actor_id
      WHERE d.status='queued' AND a.retiring_at IS NULL AND a.deleted_at IS NULL
      ORDER BY d.requested_at ASC LIMIT ${limit}`.map(toAction);
  }

  /** The actors with a row of this id, any status: ids are minted unique across them ({@link DeferredApprovalQueue}). */
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

  /** This ask's live row (its command, executor and context), never 'spent'; a decision outranks an ask, the newest
   *  wins. */
  standing(ask: { readonly command: string; readonly executor: string; readonly context: ExecutionContext }, now: number): DeferredApproval | null {
    this.actor.assertCurrent();

    const rows = this.sql<Row>`
      SELECT actor_id, id, command, executor, context, reason, status, requested_at, decided_at
      FROM deferred_approvals
      WHERE actor_id = ${this.actorId} AND command = ${ask.command} AND executor = ${ask.executor}
        AND context = ${executionContextKey(ask.context)}
        AND (status IN ('queued','approved')
          OR (status = 'denied' AND decided_at > ${now - DENIAL_STANDING_MS}))
      ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, requested_at DESC
      LIMIT 1`;

    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Delete expired denials (run on write paths); returns what each parked. */
  sweepDenials(now: number): ApprovalKind[] {
    this.actor.assertCurrent();

    const swept = this.sql<{ id: string; command: string; executor: string }>`
      DELETE FROM deferred_approvals
      WHERE actor_id = ${this.actorId} AND status = 'denied'
        AND decided_at <= ${now - DENIAL_STANDING_MS}
      RETURNING id, command, executor`;

    if (swept.length > 0) markStoreChanged(this.sql);

    for (const { id } of swept) this.dropHits(id);

    return swept.map(approvalKindOf);
  }

  /** Every ask still open on `executor` (queued, or approved and not yet taken) retired: a share's effects, when the
   *  share is revoked, leaves `owner` mode, or its slate is built anew. Their ids. */
  retireOpen(executor: string): string[] {
    this.actor.assertCurrent();

    const retired = this.sql<{ id: string }>`
      DELETE FROM deferred_approvals
      WHERE actor_id = ${this.actorId} AND executor = ${executor} AND status IN ('queued', 'approved')
      RETURNING id`;

    if (retired.length > 0) markStoreChanged(this.sql);

    for (const { id } of retired) this.dropHits(id);

    return retired.map((row) => row.id);
  }

  create(action: Omit<DeferredApproval, 'actor' | 'status' | 'decidedAt'>, hits: readonly DeferredApprovalHit[]): DeferredApproval {
    this.actor.assertCurrent();
    void this.sql`INSERT INTO deferred_approvals
        (actor_id, id, command, executor, context, reason, status, requested_at, decided_at)
      VALUES (${this.actorId}, ${action.id}, ${action.command}, ${action.executor}, ${executionContextKey(action.context)}, ${action.reason},
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
      RETURNING actor_id, id, command, executor, context, reason, status, requested_at, decided_at, spend_seq`;

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
      SELECT actor_id, id, command, executor, context, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE actor_id = ${this.actorId} AND id = ${id} LIMIT 1`;

    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Everything still parked on the owner, oldest first. */
  listQueued(limit = 100): DeferredApproval[] {
    this.actor.assertCurrent();

    return this.sql<Row>`
      SELECT actor_id, id, command, executor, context, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE actor_id = ${this.actorId} AND status='queued'
      ORDER BY requested_at ASC LIMIT ${limit}`.map(toAction);
  }
}

/** How much of a command the roster lines quote. */
const COMMAND_ECHO_MAX_CHARS = 160;

/** A row's command with where it runs, as the agent is told of it. */
function withContext(action: DeferredApproval): string {
  const where = describeExecutionContext(action.context);

  return where === '' ? action.command : `${action.command} (${where})`;
}

function clip(text: string): string {
  return text.length <= COMMAND_ECHO_MAX_CHARS ? text : `${text.slice(0, COMMAND_ECHO_MAX_CHARS)}...`;
}

/** A parked action's one-line result, returned through `denyResult`: nothing ran, which rule and machine, the id. */
function queuedActionMessage(action: DeferredApproval, hits: readonly DeferredApprovalHit[]): string {
  return `NOT RUN: queued for owner approval (${action.id}): ${ruleNames(hits)} on ${action.executor}. `
    + 'A decision will wake you.';
}

/** Result for re-issuing a refused command; mirrors safety/device-consent.ts. */
function usedApprovalMessage(id: string): string {
  return `NOT RUN: the owner approved this once (${id}), and another run of the same command used it. Ask again to run it again.`;
}

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

/** The parked bytes the writes among `parked` name. */
function boundBytes(parked: readonly ApprovalKind[]): string[] {
  return parked.flatMap((kind) => (kind.kind === 'write' ? [kind.write.next] : []));
}

/** The message on the turn a decision wakes: one for the whole batch. */
function decisionWakeMessage(decided: readonly DeferredApproval[], written: ReadonlyMap<string, WriteOutcome>): string {
  const lines: string[] = [];

  const section = (title: string, actions: readonly DeferredApproval[]): void => {
    if (actions.length > 0) lines.push(title, ...actions.map((a) => `  ${a.id}: ${clip(withContext(a))}`));
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
  /**
   * An 'always' answer to a shared slate's effect: that tool on that root stands pre-approved on the slate's `owner`
   * shares at its revision ("Always for this slate"), not as a standing grant of the environment's. Absent, 'always'
   * on one is an approval of that call alone.
   */
  preapprove?(effect: SlateEffect): Promise<void>;
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
  /** Asks blocked on a row's decision, by row id: the first answer from any surface releases them. */
  private readonly awaiting = new Map<string, Set<(settled: 'decided') => void>>();
  /** One at a time, so a delete's check sees every keep queued before it. */
  private readonly serial = serialQueue();

  constructor(private readonly deps: DeferredApprovalQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `defer-${nanoid(10)}`);
  }

  private storeOf(actorId: string): DeferredApprovalStore {
    return this.deps.store.forActor(actorId);
  }

  /** The root's own channel. */
  get channel(): DeferredApprovalChannel {
    return this.channelFor(this.deps.store.actorId);
  }

  /** The gate's view for one actor: run, or the words to hand the model, plus the way back for an unused spend. */
  channelFor(actorId: string): DeferredApprovalChannel {
    const told = (verdict: DeferredApprovalVerdict | UsedApproval) => {
      if (verdict.outcome === 'run') return { run: true, spent: verdict.spend } as const;

      if (verdict.outcome === 'used') return { run: false, reason: 'unavailable', message: usedApprovalMessage(verdict.id) } as const;

      return {
        run: false,
        // A parked action is an absence of decision, not a refusal: the owner can still approve it.
        reason: verdict.outcome === 'denied' ? 'denied' : 'unavailable',
        message: verdict.outcome === 'denied'
          ? deniedActionMessage(verdict.action)
          : queuedActionMessage(verdict.action, this.storeOf(actorId).hits(verdict.action.id)),
      } as const;
    };

    return {
      park: async (req) => {
        const verdict = await this.park(req, actorId);

        if (verdict.outcome !== 'queued') return told(verdict);
        const rules = this.storeOf(actorId).hits(verdict.action.id).filter((hit) => hit.decision === 'gate').map((hit) => hit.rule);

        return { ...told(verdict), waiting: { id: verdict.action.id, rules } };
      },
      decided: (id, signal) => this.decidedOrAborted(actorId, id, signal),
      decide: async (id, outcome) => { await this.decide([id], ANSWER_OF[outcome]); },
      take: async (id) => told(this.take(id, actorId)),
      remember: (grants) => { this.deps.remember(grants); },
      settle: async (spent, outcome) => { await this.settle(spent, outcome, actorId); },
    };
  }

  /** `decided` once the row no longer waits, its decision committed while this ask still waited on it, so the ask is
   *  told here and not woken; `aborted` when `signal` aborted first, so a later decision wakes it. */
  private decidedOrAborted(actorId: string, id: string, signal: AbortSignal): Promise<'decided' | 'aborted'> {
    const { promise, resolve } = Promise.withResolvers<'decided' | 'aborted'>();

    if (this.storeOf(actorId).get(id)?.status !== 'queued') {
      resolve('decided');

      return promise;
    }

    if (signal.aborted) {
      resolve('aborted');

      return promise;
    }

    const waiters = this.awaiting.get(id) ?? new Set();
    this.awaiting.set(id, waiters.add(resolve));

    signal.addEventListener('abort', () => {
      waiters.delete(resolve);

      if (waiters.size === 0 && this.awaiting.get(id) === waiters) this.awaiting.delete(id);
      resolve('aborted');
    }, { once: true });

    return promise;
  }

  /** The decided row `id`, finished for the ask that waited on it: its approval spent, its denial, or, when another
   *  ask of the same row ran on that approval first, a refusal that says so. Never a new row. */
  private take(id: string, actorId: string): DeferredApprovalVerdict | UsedApproval {
    const store = this.storeOf(actorId);
    const action = store.get(id);

    if (action?.status === 'approved') {
      const spent = store.spend(id);

      if (spent) return { outcome: 'run', action: spent.action, spend: spent.spend };
    }

    if (action?.status === 'denied') return { outcome: 'denied', action };

    return action?.status === 'queued' ? { outcome: 'queued', action } : { outcome: 'used', id };
  }

  /** Parks an action or answers with the owner's standing decision; a re-ask returns the same row, so the turn's
   *  repeat detector sees a loop. A write's bytes are kept first, then held until its row names them. */
  async park(req: ShellApprovalRequest, actorId: string = this.deps.store.actorId): Promise<DeferredApprovalVerdict> {
    const { writes } = this.deps;
    const parked = approvalKindOf(req);
    const digest = parked.kind === 'write' ? parked.write.next : undefined;
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

  /** The answer a row of this ask already holds: its denial, its approval spent, or the row still waiting. */
  private held(req: ShellApprovalRequest, now: number, store: DeferredApprovalStore): DeferredApprovalVerdict | null {
    const standing = store.standing({ command: req.command, executor: req.executor, context: req.context }, now);

    if (standing?.status === 'denied') return { outcome: 'denied', action: standing };

    if (standing?.status === 'approved') {
      // Spend before running so a crash loses an approval rather than granting twice.
      const spent = store.spend(standing.id);

      // Null: a concurrent re-issue won it, and no row holds this ask any more.
      return spent === null ? null : { outcome: 'run', action: spent.action, spend: spent.spend };
    }

    return standing?.status === 'queued' ? { outcome: 'queued', action: standing } : null;
  }

  private answer(req: ShellApprovalRequest, now: number, store: DeferredApprovalStore): DeferredApprovalVerdict {
    const held = this.held(req, now, store);

    if (held !== null) return held;

    const action = store.create({
      id: this.unusedId(),
      command: req.command,
      executor: req.executor,
      context: req.context,
      reason: formatApproval(req.review),
      requestedAt: now,
    }, req.review.hits.map(({ rule, decision }) => ({ rule, decision })));

    this.notify({ kind: 'queued', action });

    return { outcome: 'queued', action };
  }

  /** An id no actor's row has: the owner answers by id alone, so one id is one ask. */
  private unusedId(): string {
    let id = this.newId();

    while (this.deps.store.owners(id).length > 0) id = this.newId();

    return id;
  }

  /** Closes a spend: 'spent' consumes and audits the grant, 'did-not-run' restores the row; whether this call closed it. */
  async settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome, actorId: string = this.deps.store.actorId): Promise<boolean> {
    const store = this.storeOf(actorId);
    const action = store.get(spent.approvalId);

    if (!store.settle(spent, outcome)) return false;

    if (outcome === 'spent' && action) {
      this.audit(action);
      // A re-issued write ran on its own bytes, so the parked copy goes.
      await this.release(boundBytes([approvalKindOf(action)]));
    }

    return true;
  }

  private audit(action: DeferredApproval): void {
    settleLoggedSync('approval.audit_emit_failed', { doing: 'recording an approval_consumed run event', otherwise: 'io' }, () => {
      this.deps.audit?.({
        approvalId: action.id, actor: action.actor, command: action.command, executor: action.executor,
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
    const swept: ApprovalKind[] = [];

    // Deduped so one command is not reported as two decisions; an id two actors share answers neither.
    for (const id of new Set(ids)) {
      const [actorId, ...others] = this.deps.store.owners(id);

      if (actorId === undefined || others.length > 0) continue;
      const store = this.storeOf(actorId);
      swept.push(...store.sweepDenials(now));
      const action = store.decide(id, answer, now);

      if (action) decided.push(action);
    }

    if (answer === 'always' && decided.length > 0) {
      const kinds = decided.map((action) => ({ action, kind: approvalKindOf(action) }));

      // Kept as the rows are decided, before any ask runs on them: one that runs settles its row and its hits.
      // Not re-reviewed: that would lose the call's member and cwd. A shared slate's effect is no rule of the
      // environment's: it stands for that slate alone.
      this.deps.remember(kinds.flatMap(({ action, kind }) => (kind.kind === 'slate-effect' ? [] : gatedGrants(this.storeOf(action.actor).hits(action.id), action.executor))));

      for (const { kind } of kinds) if (kind.kind === 'slate-effect') await this.deps.preapprove?.(kind.effect);
    }

    // An ask blocked on its row hears the answer there, at the moment it is recorded, and runs on it now; only an ask
    // that went away before is woken.
    const blocked = decided.filter((action) => this.awaiting.has(action.id));

    for (const action of blocked) {
      for (const resume of this.awaiting.get(action.id) ?? []) resume('decided');
      this.awaiting.delete(action.id);
    }

    await this.release(boundBytes([...swept, ...decided.filter((a) => a.status === 'denied').map(approvalKindOf)]));

    if (decided.length === 0) return decided;

    const written = await this.performWrites(decided.filter((a) => a.actor === this.deps.store.actorId));
    this.notify({ kind: 'decided', actions: decided });
    // A shared slate's effect is taken by its own call's next run: no agent asked it, so none is woken for it.
    const told = decided.filter((a) => !blocked.includes(a) && approvalKindOf(a).kind !== 'slate-effect');

    // Each asker once, every one tried: the decision is already durable, and one asker's failed wake (an agent
    // retired meanwhile) is no reason another goes untold. The failures are the answer's, after.
    const wakes = Effect.forEach(new Set(told.map((a) => a.actor)), (actorId) => {
      const own = told.filter((a) => a.actor === actorId);

      return Effect.result(this.deps.wake(actorId, {
        kind: DEFERRED_APPROVAL_SIGNAL,
        text: decisionWakeMessage(own, written),
        metadata: { decision: answer, count: own.length, ids: own.map((a) => a.id) },
      }));
    });

    return settle(Effect.flatMap(wakes, (results) => {
      const failed = results.flatMap((result) => (Result.isFailure(result) ? [result.failure] : []));
      const [first] = failed;

      return first === undefined ? Effect.succeed(decided) : Effect.fail(failed.length === 1 ? first : new KinuError(
        first.code, `${String(failed.length)} agents were not told of the decision: ${failed.map((error) => error.message).join('; ')}`,
      ));
    }));
  }

  /** The bytes are read while the approved row still names them, then the row is spent, so a re-issue meanwhile
   *  cannot write twice. */
  private async performWrites(decided: readonly DeferredApproval[]): Promise<ReadonlyMap<string, WriteOutcome>> {
    const written = new Map<string, WriteOutcome>();
    const { writes } = this.deps;
    const store = this.storeOf(this.deps.store.actorId);

    for (const action of writes === null ? [] : decided) {
      const parked = approvalKindOf(action);
      const write = action.status === 'approved' && parked.kind === 'write' ? parked.write : null;

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

  /**
   * A call a shared slate's server makes with its owner's access (approval-kind.ts `slate-effect`), named by `id`, its
   * exact call: run on the owner's approval, which it takes, so one approval admits it once; else asked of the owner,
   * or refused while their decline stands. Its run settles the spend it was handed ({@link settle}), so a crash before
   * it ran gives the approval back and one after it never runs it twice.
   */
  slateEffect(id: string, effect: SlateEffect): SlateEffectVerdict {
    const now = this.now();
    const store = this.deps.store;
    const held = store.get(id);

    if (held?.status === 'approved') return { outcome: 'approved' };

    if (held?.status === 'queued' || held?.status === 'spent') return { outcome: 'asked', action: held };

    if (held?.status === 'denied' && held.decidedAt !== null && held.decidedAt > now - DENIAL_STANDING_MS) return { outcome: 'denied', action: held };
    store.sweepDenials(now);

    const action = store.create({
      id, command: slateEffectText(effect), executor: slateEffectExecutor(effect.slate), context: {}, requestedAt: now,
      reason: `A shared slate's server, running with your access for ${effect.viewer}, asked to call ${effect.tool} on ${effect.server}`,
    }, []);

    this.notify({ kind: 'queued', action });

    return { outcome: 'asked', action };
  }

  /**
   * The owner's approval of this exact call taken, where the call is sent: one synchronous write, so nothing between it
   * and the send can take it back. The spend the call settles, or null where it is no longer approved (retired, or
   * already taken).
   */
  takeSlateEffect(id: string): ApprovalSpend | null {
    return this.deps.store.spend(id)?.spend ?? null;
  }

  /** A shared server's open effects retired: one of its shares was revoked or changed mode, or it was built anew. */
  retireSlateEffects(slate: string): string[] {
    return this.deps.store.retireOpen(slateEffectExecutor(slate));
  }

  /** A queued write's change, whoever parked it. */
  async parkedWrite(id: string): Promise<{ readonly write: BoundFileWrite; readonly bytes: Uint8Array } | null> {
    const action = this.deps.store.owners(id).map((actorId) => this.storeOf(actorId).get(id)).find((row) => row?.status === 'queued');
    const parked = action === undefined || action === null ? null : approvalKindOf(action);
    const write = parked?.kind === 'write' ? parked.write : null;
    const bytes = write === null ? null : await this.deps.writes?.content.read(write.next) ?? null;

    return write === null || bytes === null ? null : { write, bytes };
  }

  /** Everything still parked in the workspace, oldest first, each with the actor that asked. */
  list(): DeferredApproval[] {
    return this.deps.store.workspaceQueued();
  }

  /** One actor's parked actions for its per-step dynamic-context block, re-telling the turn they have not run. */
  approvals(actorId: string = this.deps.store.actorId): DynamicApproval[] {
    // A shared slate's effect is the owner's to decide and its share's to run: it is no part of an agent's turn.
    return this.storeOf(actorId).listQueued().filter((action) => approvalKindOf(action).kind !== 'slate-effect').map((action) => ({
      id: action.id,
      kind: 'queued command (NOT run)',
      detail: clip(withContext(action)),
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
