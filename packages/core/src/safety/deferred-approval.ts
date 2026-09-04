/**
 * Deferred approval — what a gated action does when the owner is asleep.
 *
 * The failure this exists for: an agent left running overnight reaches one
 * `sudo` on step 40, the approval channel has nobody behind it, and the whole
 * run stops there. Five minutes later the prompt expires and the gate answers
 * `deny` — so the run has not only stalled, it has been told a refusal that
 * nobody made.
 *
 * Cloudflare's own answer is for the gatekeeper to report success so the agent
 * keeps queueing work, and to let the human approve the pile later. That is
 * fast and it is a lie: the agent then plans on top of an effect that has not
 * happened. This module implements the other answer — the action is parked on
 * the owner and the agent is TOLD it is parked:
 *
 *   • the tool result says queued, names the id, and states plainly that
 *     nothing ran — in one line, because the doctrine around it (that a
 *     decision wakes you, that you may carry on or stop, that re-issuing
 *     returns the same answer) is a standing fact about the tool surface and
 *     belongs in the system prompt ONCE, not in every parked result;
 *   • the owner decides later, in bulk, from the needs-you queue;
 *   • the decision wakes the agent through the ONE signal seam every other
 *     asynchronous producer uses (orchestrator/signals.ts) — the same
 *     wake-on-settle path a background job takes.
 *
 * THE HONESTY INVARIANT, structurally:
 *
 *   1. A queued action returns through `denyResult` — the same return path a
 *      refusal takes, in the wrapped function's own failure shape (a `Shell`
 *      gets `exitCode: 1`). `execute` is simply never called, so there is no
 *      code path that can produce a success-shaped result for an action that
 *      did not run. It is not a convention; the success shape is unreachable.
 *   2. The status vocabulary has no "ran" in it. 'approved' means the owner
 *      said yes and the command STILL has not executed — permission is not an
 *      effect. The grant is consumed by the agent re-issuing the command,
 *      which is when the command actually runs, with the agent watching.
 *   3. Every action still parked is re-stated in the per-step dynamic-context
 *      block ({@link DeferredApprovalQueue.approvals}), so a turn that later
 *      depends on the effect reads, on every single step, that it has not
 *      happened.
 *
 * Durable because the whole point is a night: the Durable Object is evicted
 * many times between the ask and the answer, so the queue is SQL, not a map of
 * parked promises (which is what device consent correctly is — that one waits
 * minutes, in memory, with the caller blocked).
 */

import type { DynamicApproval } from '../prompting/volatile-context';
import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { SignalDeliverer } from '../types/signals';
import type { ApprovalConsumedRecord } from '../events/types';
import * as v from 'valibot';
import { reconcileColumns } from '../identity/columns';
import {
  formatApproval, gatedGrants, reviewCommand,
  type ApprovalGrant, type ApprovalSpend, type ApprovalSpendOutcome,
  type DeferredApprovalChannel, type ShellApprovalRequest,
} from './approval-gate';
import { nanoid } from '../utils/nanoid';
import { diagnostics, toKinuError } from '../obs/index';

/** The `kinuEvent` kind a decision wakes the agent under — its own name,
 *  not `background_job`'s: the card the owner sees, and the provenance stamped
 *  on the woken turn, must say what actually happened. The MECHANISM is the
 *  background-job wake verbatim (SignalDelivery.deliver → next step, or a turn
 *  of its own when the agent is idle). */
export const DEFERRED_APPROVAL_SIGNAL = 'deferred_approval';

/**
 * Where a parked action is.
 *
 * There is deliberately no terminal "executed" state: this queue records
 * PERMISSION, and permission is granted here while the effect happens
 * somewhere else (the agent re-issuing the command through the gate). A state
 * meaning "done" would be a state this module cannot honestly write.
 */
export type DeferredApprovalStatus =
  /** Parked on the owner. Nobody has decided. */
  | 'queued'
  /** The owner said yes. The command has not run; the grant is unspent. */
  | 'approved'
  /** The owner said no. */
  | 'denied'
  /** The grant has been handed to a command that is running RIGHT NOW, and no
   *  longer answers `standing()`. Not a resting state: the gate closes every
   *  spend it makes, either by deleting the row (the command reached its
   *  machine) or by putting it back to 'approved' (it provably did not). A row
   *  left here is a process that died mid-command, and the grant it held is
   *  lost — which is the safe direction and the reason the spend comes first.
   *  The `approval_consumed` run event is the durable audit either way. */
  | 'spent';

/** What the owner can pick. `queued` is a state the queue reaches on its own.
 *  `always` is `approved` plus a standing grant for the rules this command
 *  tripped on the executor it was bound for — the same ask-once-then-remember
 *  shape device consent uses for a device. */
export type DeferredApprovalAnswer = Extract<DeferredApprovalStatus, 'approved' | 'denied'> | 'always';

/** One action parked on the owner. */
export interface DeferredApproval {
  readonly id: string;
  /** The exact command the agent asked to run. */
  readonly command: string;
  /** The machine it was bound for. Half the question: the same string on the
   *  owner's laptop and in the agent's own workspace are different asks, and a
   *  grant given for one must not answer for the other. */
  readonly executor: string;
  /** Why the gate stopped it — `formatApproval` of the review that fired. */
  readonly reason: string;
  readonly status: DeferredApprovalStatus;
  readonly requestedAt: number;
  /** When the owner answered, or null while it is still parked. */
  readonly decidedAt: number | null;
}

/**
 * What the gate learns when it consults the queue about a command.
 *
 * `run` is the ONLY verdict that lets execution proceed, and reaching it has
 * already spent the grant — so a second attempt at the same command parks
 * again rather than riding one approval twice. It names the spend it made,
 * because the gate has to close that spend once it knows whether the command
 * reached its machine.
 */
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

const DEFERRED_APPROVAL_ADDED_COLUMNS = {
  executor: "TEXT NOT NULL DEFAULT ''",
  // How many times this grant has been handed to a command. A settle names the
  // spend it is closing, so a replayed or late settle cannot reopen a grant a
  // later attempt already holds.
  spend_seq: 'INTEGER NOT NULL DEFAULT 0',
} as const;

export function initDeferredApprovalsTable(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(`CREATE TABLE IF NOT EXISTS deferred_approvals (
    id           TEXT PRIMARY KEY,
    command      TEXT NOT NULL,
    executor     TEXT NOT NULL DEFAULT '',
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    requested_at INTEGER NOT NULL,
    decided_at   INTEGER
  )`);
  reconcileColumns(sql, execRaw, 'deferred_approvals', DEFERRED_APPROVAL_ADDED_COLUMNS);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_deferred_approvals_status ON deferred_approvals(status)`);
}

/**
 * The durable rows. Pure storage — what the words say and who gets woken is
 * {@link DeferredApprovalQueue}'s.
 */
export class DeferredApprovalStore {
  constructor(private readonly sql: SqlExecutor) {}

  /** The live row for this exact command ON THIS EXECUTOR, if there is one.
   *  'queued' (waiting) and 'approved' (grant unspent) are the two live
   *  states; 'denied' is the owner's standing answer and is also read back
   *  here, so a refusal is reported rather than re-asked. A grant that is out
   *  with a running command is 'spent' and is deliberately NOT here: while it
   *  is out it answers for nobody. The executor is part of the key because an
   *  approval for the agent's own workspace is not an approval for the owner's
   *  laptop.
   *
   *  A DECISION outranks a pending ask, and only then does the newest win. One
   *  key can hold both once a refund puts a grant back while a second re-issue
   *  has already parked a fresh row beside it — two consumers of one approval
   *  is the shape this whole mechanism exists for. Answering the newer QUEUED
   *  row there would ask the owner for something they have already answered,
   *  which is the complaint, not the fix. Between two decisions the newest
   *  still wins, so the owner's latest word governs.
   */
  standing(command: string, executor: string): DeferredApproval | null {
    const rows = this.sql<Row>`
      SELECT id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals
      WHERE command = ${command} AND executor = ${executor}
        AND status IN ('queued','approved','denied')
      ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END, requested_at DESC
      LIMIT 1`;
    return rows[0] ? toAction(rows[0]) : null;
  }

  create(action: Omit<DeferredApproval, 'status' | 'decidedAt'>): DeferredApproval {
    void this.sql`INSERT INTO deferred_approvals
        (id, command, executor, reason, status, requested_at, decided_at)
      VALUES (${action.id}, ${action.command}, ${action.executor}, ${action.reason},
        'queued', ${action.requestedAt}, NULL)`;
    return { ...action, status: 'queued', decidedAt: null };
  }

  /**
   * Record the owner's answer, and report the row only if THIS call is what
   * changed it — so a second click, or a bulk action overlapping a single one,
   * decides nothing twice and wakes the agent about nothing twice.
   *
   * The read and the write are one call with no await between them, which on
   * the single-threaded SQLite both backends run is the whole transaction;
   * the `status='queued'` guard on the write is the belt to that's braces.
   */
  decide(id: string, answer: DeferredApprovalAnswer, now: number): DeferredApproval | null {
    if (this.get(id)?.status !== 'queued') return null;
    // 'always' is 'approved' plus a grant the QUEUE records; the row only ever
    // holds a status this module can honestly write about this one command.
    const status = answer === 'always' ? 'approved' : answer;
    void this.sql`UPDATE deferred_approvals SET status=${status}, decided_at=${now}
      WHERE id=${id} AND status='queued'`;
    return this.get(id);
  }

  /**
   * Hand an approved grant to a command that is about to run.
   *
   * The grant leaves `standing()` HERE, before the command runs, so a crash
   * between the two costs an approval rather than granting one twice. It is a
   * transition on the row and not a deletion, because the row's identity is
   * what a refund needs: {@link settle} either finishes the spend by deleting
   * the row or puts THAT SAME row back to the state the owner approved. There
   * is no path in this store that creates an approved row, so a grant can
   * never be minted by giving one back.
   *
   * Returns the action and which spend of it this is, or null when another
   * call got there first.
   */
  spend(id: string): { readonly action: DeferredApproval; readonly spend: ApprovalSpend } | null {
    const rows = this.sql<SpendRow>`
      UPDATE deferred_approvals SET status='spent', spend_seq = spend_seq + 1
      WHERE id = ${id} AND status = 'approved'
      RETURNING id, command, executor, reason, status, requested_at, decided_at, spend_seq`;
    const row = rows[0];
    if (!row) return null;
    return {
      action: toAction(row),
      spend: { approvalId: row.id, spend: row.spend_seq },
    };
  }

  /**
   * Close out a spend: consume the grant for good, or give it back.
   *
   * Guarded on the spend counter as well as the id, which is what makes this
   * idempotent and replay-safe. A settle of a spend that is already closed
   * matches no row and does nothing — so settling twice changes nothing, and a
   * stale settle arriving after a LATER attempt took the grant cannot reach it.
   *
   * Reports whether this call is what moved the row, for the same reason
   * {@link decide} does: a caller that announces an outcome must announce it
   * once.
   */
  settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome): boolean {
    const rows = outcome === 'did-not-run'
      ? this.sql<{ id: string }>`
          UPDATE deferred_approvals SET status='approved'
          WHERE id = ${spent.approvalId} AND status='spent' AND spend_seq = ${spent.spend}
          RETURNING id`
      : this.sql<{ id: string }>`
          DELETE FROM deferred_approvals
          WHERE id = ${spent.approvalId} AND status='spent' AND spend_seq = ${spent.spend}
          RETURNING id`;
    return rows.length > 0;
  }

  get(id: string): DeferredApproval | null {
    const rows = this.sql<Row>`
      SELECT id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE id = ${id} LIMIT 1`;
    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Everything still parked on the owner, oldest first — the one that has
   *  been blocked longest matters most. */
  listQueued(limit = 100): DeferredApproval[] {
    return this.sql<Row>`
      SELECT id, command, executor, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE status='queued'
      ORDER BY requested_at ASC LIMIT ${limit}`.map(toAction);
  }
}

/** How much of a command the roster lines quote. Long enough to recognise a
 *  command, short enough that ten parked actions do not crowd out the turn's
 *  own context. The full text is always in the queued result the agent already
 *  read, and in the owner's UI. */
const COMMAND_ECHO_MAX_CHARS = 160;

function clip(text: string): string {
  return text.length <= COMMAND_ECHO_MAX_CHARS ? text : `${text.slice(0, COMMAND_ECHO_MAX_CHARS)}…`;
}

/**
 * The words the agent reads when its action is parked.
 *
 * One line. It carries only what this call site knows and the prompt cannot:
 * that nothing ran, which rule stopped it, on which machine, and the id the
 * decision will arrive under. Everything else the agent needs to know about
 * parked actions — that a decision wakes it, that it may carry on or stop,
 * that re-issuing returns the same answer — is true of every parked action on
 * every turn, so it is stated once in the system prompt instead of ~280
 * tokens per call. The honesty invariant is unchanged: this still returns
 * through `denyResult`, so the success shape stays unreachable.
 */
export function queuedActionMessage(action: DeferredApproval): string {
  return `NOT RUN — queued for owner approval (${action.id}): ${ruleNames(action)} on ${action.executor}. `
    + 'A decision will wake you.';
}

/** The words on a re-issue of a command the owner has already refused. Mirrors
 *  device consent's doctrine (safety/device-consent.ts): a denial is an answer,
 *  and asking again immediately is noise. */
export function deniedActionMessage(action: DeferredApproval): string {
  return `NOT RUN — the owner refused this (${action.id}). Not a timeout; find another way.`;
}

/** The rules the review named, for a one-line result. The full prose is in
 *  `action.reason`, which is what the owner's queue renders — the model does
 *  not need the explanations, it needs to know which of its own habits tripped
 *  the gate. */
function ruleNames(action: DeferredApproval): string {
  const names = [...action.reason.matchAll(/^• ([\w-]+) \(/gm)].map((m) => m[1]);
  return names.length > 0 ? names.join(', ') : 'needs approval';
}

/** The words on the turn a decision wakes. One message for the whole batch,
 *  because the owner decides a night's worth in one sitting and N wakes for
 *  one sitting is N turns' worth of noise for one piece of news. */
export function decisionWakeMessage(decided: readonly DeferredApproval[]): string {
  const lines: string[] = [];
  const approved = decided.filter((a) => a.status === 'approved');
  const denied = decided.filter((a) => a.status === 'denied');
  // "Still not run" is the one thing worth repeating here: it is the exact
  // mistake an agent makes on waking, and the prompt cannot say it per-id.
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
  /** The ONE way anything asynchronous reaches the agent. A decision is
   *  delivered exactly as a settled background job is: spliced into the live
   *  turn's next step, or started as its own turn when the agent is idle. */
  readonly signals: SignalDeliverer;
  /** Record a standing grant the owner just gave by answering 'always'. The
   *  host owns where that lives (agent_config, alongside the approval mode),
   *  so the queue only says WHAT was granted. Required, not optional: an
   *  'always' button whose grant went nowhere is the worst of both. */
  remember(grants: readonly ApprovalGrant[]): void;
  /** The durable audit for a CONSUMED grant — where the `approval_consumed`
   *  run event is written. A host records it into the run-event log of the
   *  turn that spent the approval, which is the read model that replaces the
   *  deleted row. Optional only so a gate can run unrecorded in tests; a
   *  production host wires it, because without it a spent grant leaves no
   *  trace at all. */
  audit?(record: ApprovalConsumedRecord): void;
  /** Mint a request id. Injected so a host keeps its own id vocabulary and
   *  tests stay deterministic. */
  newId?(): string;
  now?(): number;
  /** Told when an action is parked and when a batch is decided — the host's
   *  activity line and client fan-out. Never throws into the gate. */
  announce?(event: DeferredApprovalNotice): void;
}

/** What the host is told as actions come and go. */
export type DeferredApprovalNotice =
  | { readonly kind: 'queued'; readonly action: DeferredApproval }
  | { readonly kind: 'decided'; readonly actions: readonly DeferredApproval[] };

/**
 * The parked-action queue: the gate's channel, the owner's decision surface,
 * and the wake that joins them.
 */
export class DeferredApprovalQueue {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: DeferredApprovalQueueDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => `defer-${nanoid(10)}`);
  }

  /** The gate's view of this queue: run, or the words to hand the model
   *  instead, plus the way back for a spend that bought nothing. The gate
   *  learns nothing else — see approval-gate.ts's
   *  {@link DeferredApprovalChannel}. */
  get channel(): DeferredApprovalChannel {
    return {
      park: (req) => {
        const verdict = this.park(req);
        if (verdict.outcome === 'run') return { run: true, spent: verdict.spend };
        return {
          run: false,
          message: verdict.outcome === 'denied'
            ? deniedActionMessage(verdict.action)
            : queuedActionMessage(verdict.action),
        };
      },
      settle: (spent, outcome) => { this.settle(spent, outcome); },
    };
  }

  /**
   * Park an action, or answer with the owner's standing decision.
   *
   * Re-asking an already-parked command returns the SAME row — same id, same
   * words — rather than minting a second one: it is one decision, and an
   * identical answer is what makes the turn's own repeat detector see a loop
   * (orchestrator/turn-steering.ts) instead of a queue filling with duplicates.
   */
  park(req: ShellApprovalRequest): DeferredApprovalVerdict {
    const standing = this.deps.store.standing(req.command, req.executor);
    if (standing?.status === 'denied') return { outcome: 'denied', action: standing };
    if (standing?.status === 'approved') {
      // The grant leaves `standing()` HERE, before the command runs, so a crash
      // between the two costs an approval rather than granting one twice. The
      // row survives the spend so {@link settle} can close it either way.
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
      requestedAt: this.now(),
    });
    this.notify({ kind: 'queued', action });
    return { outcome: 'queued', action };
  }

  /**
   * Close a spend {@link park} made, once the gate knows what became of the
   * command.
   *
   * 'spent' consumes the grant for good and writes the `approval_consumed`
   * audit. 'did-not-run' puts the SAME row back to the state the owner
   * approved it in and writes nothing, because nothing was consumed — an audit
   * for a grant that is still sitting there unspent would be a false entry in a
   * permanent log.
   *
   * The audit is written HERE rather than at the spend for that reason. A
   * process that dies between the spend and this call leaves no event and a row
   * stuck at 'spent' — the grant is lost, which is the safe direction, and the
   * stranded row is the evidence that it was taken.
   *
   * Reports whether this call is what closed the spend, so a replay is visibly
   * a no-op rather than a silent one.
   */
  settle(spent: ApprovalSpend, outcome: ApprovalSpendOutcome): boolean {
    const action = this.deps.store.get(spent.approvalId);
    if (!this.deps.store.settle(spent, outcome)) return false;
    if (outcome === 'spent' && action) {
      this.deps.audit?.({
        approvalId: action.id, command: action.command, executor: action.executor,
      });
    }
    return true;
  }

  /**
   * The owner decided — one action or a night's worth in one click.
   *
   * `always` additionally remembers the rules this command tripped, on the
   * executor it was bound for, so the next command of that kind in that place
   * does not come back here. It is not a wider permission than `approved` —
   * same gate, same rules, same executor; only the asking stops.
   *
   * Rows are written before the wake, so the decision is durable even if the
   * agent cannot be reached, and ONE signal carries the whole batch.
   */
  async decide(ids: readonly string[], answer: DeferredApprovalAnswer): Promise<DeferredApproval[]> {
    const now = this.now();
    const decided: DeferredApproval[] = [];
    // Deduped: a UI that sends an id twice must not report it twice, or the
    // wake would name one command as two decisions.
    for (const id of new Set(ids)) {
      const action = this.deps.store.decide(id, answer, now);
      if (action) decided.push(action);
    }
    if (decided.length === 0) return decided;
    if (answer === 'always') {
      // Recomputed from the command and its executor rather than stored: the
      // rule table is the one source of truth for what a command trips, and
      // reading it now is what keeps a grant honest about today's rules.
      this.deps.remember(decided.flatMap(
        (a) => gatedGrants(reviewCommand(a.command, a.executor), a.executor)));
    }
    this.notify({ kind: 'decided', actions: decided });
    await this.deps.signals.deliver({
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

  /** The parked actions as the per-step dynamic-context block names them —
   *  the structural half of the honesty invariant: a turn that queued an
   *  action is re-told, on every step until it is decided, that the action has
   *  not run. */
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
