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
 *     nothing ran;
 *   • the agent is told it may carry on with independent work or end its turn,
 *     and that it is woken either way;
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

import type { DynamicApproval } from '../prompting/volatile-context.js';
import type { RawSqlExec, SqlExecutor } from '../types/primitives.js';
import type { SignalDeliverer } from '../types/signals.js';
import {
  formatApproval,
  type DeferredApprovalChannel, type ShellApprovalRequest,
} from './approval-gate.js';
import { nanoid } from '../utils/nanoid.js';

/** The `proteusEvent` kind a decision wakes the agent under — its own name,
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
  /** The owner said yes and the agent has since re-issued the command, so the
   *  grant is spent — a second run needs a second approval. */
  | 'used';

/** The owner's two answers. `queued` and `used` are states the queue reaches
 *  on its own, not things a human can pick. */
export type DeferredApprovalAnswer = Extract<DeferredApprovalStatus, 'approved' | 'denied'>;

/** One action parked on the owner. */
export interface DeferredApproval {
  readonly id: string;
  /** The exact command the agent asked to run. */
  readonly command: string;
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
 * again rather than riding one approval twice.
 */
export type DeferredApprovalVerdict =
  | { readonly outcome: 'run'; readonly action: DeferredApproval }
  | { readonly outcome: 'denied'; readonly action: DeferredApproval }
  | { readonly outcome: 'queued'; readonly action: DeferredApproval };

interface Row {
  id: string; command: string; reason: string; status: string;
  requested_at: number; decided_at: number | null;
}

function toAction(r: Row): DeferredApproval {
  return {
    id: r.id,
    command: r.command,
    reason: r.reason,
    status: STATUSES.has(r.status) ? r.status as DeferredApprovalStatus : 'queued',
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
  };
}

const STATUSES: ReadonlySet<string> = new Set<DeferredApprovalStatus>(
  ['queued', 'approved', 'denied', 'used'],
);

export function initDeferredApprovalsTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS deferred_approvals (
    id           TEXT PRIMARY KEY,
    command      TEXT NOT NULL,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',
    requested_at INTEGER NOT NULL,
    decided_at   INTEGER
  )`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_deferred_approvals_status ON deferred_approvals(status)`);
}

/**
 * The durable rows. Pure storage — what the words say and who gets woken is
 * {@link DeferredApprovalQueue}'s.
 */
export class DeferredApprovalStore {
  constructor(private readonly sql: SqlExecutor) {}

  /** The live row for this exact command, if there is one. 'queued' (waiting)
   *  and 'approved' (grant unspent) are the two live states; 'denied' is the
   *  owner's standing answer and is also read back here, so a refusal is
   *  reported rather than re-asked. A spent grant ('used') is history. */
  standing(command: string): DeferredApproval | null {
    const rows = this.sql<Row>`
      SELECT id, command, reason, status, requested_at, decided_at
      FROM deferred_approvals
      WHERE command = ${command} AND status IN ('queued','approved','denied')
      ORDER BY requested_at DESC LIMIT 1`;
    return rows[0] ? toAction(rows[0]) : null;
  }

  create(action: Omit<DeferredApproval, 'status' | 'decidedAt'>): DeferredApproval {
    this.sql`INSERT INTO deferred_approvals (id, command, reason, status, requested_at, decided_at)
      VALUES (${action.id}, ${action.command}, ${action.reason}, 'queued', ${action.requestedAt}, NULL)`;
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
    this.sql`UPDATE deferred_approvals SET status=${answer}, decided_at=${now}
      WHERE id=${id} AND status='queued'`;
    return this.get(id);
  }

  /** Spend an approved grant, reporting true only if this call is what spent
   *  it — so one approval can never authorise two runs. */
  spend(id: string): boolean {
    if (this.get(id)?.status !== 'approved') return false;
    this.sql`UPDATE deferred_approvals SET status='used' WHERE id=${id} AND status='approved'`;
    return this.get(id)?.status === 'used';
  }

  get(id: string): DeferredApproval | null {
    const rows = this.sql<Row>`
      SELECT id, command, reason, status, requested_at, decided_at
      FROM deferred_approvals WHERE id = ${id} LIMIT 1`;
    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Everything still parked on the owner, oldest first — the one that has
   *  been blocked longest matters most. */
  listQueued(limit = 100): DeferredApproval[] {
    return this.sql<Row>`
      SELECT id, command, reason, status, requested_at, decided_at
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
 * The exact words the agent reads when its action is parked.
 *
 * Written to be impossible to mistake for a result: it says what did NOT
 * happen before it says anything else, it names both of the agent's real
 * options, and it promises the wake that the signal seam actually delivers.
 */
export function queuedActionMessage(action: DeferredApproval): string {
  return [
    `Queued for the owner's approval — NOT RUN. Request id: ${action.id}.`,
    '',
    `  ${action.command}`,
    '',
    action.reason,
    '',
    'Nothing was executed, nothing changed, and there is no result for this action. Do not carry on as '
    + 'if it had run: if a later step needs its effect, that effect does not exist yet.',
    '',
    'The owner is not available to decide right now, so this is waiting in their queue. You will be woken '
    + 'with their decision either way — mid-step while you are still working, or as a turn of its own '
    + 'once this one is over. So you may either:',
    '  (a) carry on with work that does not depend on this action, or',
    '  (b) end your turn now and pick this up when the decision arrives.',
    'Both are fine. What is not fine is re-issuing the same command to see if it goes through — it will '
    + 'return this same queued answer until the owner decides.',
  ].join('\n');
}

/** The words on a re-issue of a command the owner has already refused. Mirrors
 *  device consent's doctrine (safety/device-consent.ts): a denial is an answer,
 *  and asking again immediately is noise. */
export function deniedActionMessage(action: DeferredApproval): string {
  return [
    `The owner refused this command when they reviewed the approval queue (request ${action.id}) — NOT RUN.`,
    '',
    `  ${action.command}`,
    '',
    'This is a decision, not a timeout, so re-issuing it will keep returning this. Find another way to do '
    + 'the job, or explain to the owner why this specific command is needed and let them approve it or '
    + 'change the shell approval mode themselves.',
  ].join('\n');
}

/** The words on the turn a decision wakes. One message for the whole batch,
 *  because the owner decides a night's worth in one sitting and N wakes for
 *  one sitting is N turns' worth of noise for one piece of news. */
export function decisionWakeMessage(decided: readonly DeferredApproval[]): string {
  const approved = decided.filter((a) => a.status === 'approved');
  const denied = decided.filter((a) => a.status === 'denied');
  const lines: string[] = [
    `The owner has decided ${decided.length} of the action${decided.length === 1 ? '' : 's'} you queued for approval.`,
  ];
  if (approved.length > 0) {
    lines.push(
      '',
      'APPROVED — these have still NOT RUN. Approval is permission, not an effect: re-issue the command '
      + 'exactly as written and it will go through once.',
      ...approved.map((a) => `  • ${a.id} — ${clip(a.command)}`),
    );
  }
  if (denied.length > 0) {
    lines.push(
      '',
      'DENIED — the owner refused these. Do not re-issue them; find another way, or ask the owner directly.',
      ...denied.map((a) => `  • ${a.id} — ${clip(a.command)}`),
    );
  }
  lines.push(
    '',
    'Pick up whatever you parked on these decisions. If nothing was waiting on them, say so and stop.',
  );
  return lines.join('\n');
}

export interface DeferredApprovalQueueDeps {
  readonly store: DeferredApprovalStore;
  /** The ONE way anything asynchronous reaches the agent. A decision is
   *  delivered exactly as a settled background job is: spliced into the live
   *  turn's next step, or started as its own turn when the agent is idle. */
  readonly signals: SignalDeliverer;
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
   *  instead. The gate learns nothing else — see approval-gate.ts's
   *  {@link DeferredApprovalChannel}. */
  get channel(): DeferredApprovalChannel {
    return {
      park: (req) => {
        const verdict = this.park(req);
        if (verdict.outcome === 'run') return { run: true };
        return {
          run: false,
          message: verdict.outcome === 'denied'
            ? deniedActionMessage(verdict.action)
            : queuedActionMessage(verdict.action),
        };
      },
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
    const standing = this.deps.store.standing(req.command);
    if (standing?.status === 'denied') return { outcome: 'denied', action: standing };
    if (standing?.status === 'approved') {
      // The grant is spent HERE, before the command runs, so a crash between
      // the two costs an approval rather than granting one twice.
      if (this.deps.store.spend(standing.id)) {
        return { outcome: 'run', action: { ...standing, status: 'used' } };
      }
      // Lost the race to a concurrent re-issue: fall through and park again.
    }
    if (standing?.status === 'queued') return { outcome: 'queued', action: standing };

    const action = this.deps.store.create({
      id: this.newId(),
      command: req.command,
      reason: formatApproval(req.review),
      requestedAt: this.now(),
    });
    this.notify({ kind: 'queued', action });
    return { outcome: 'queued', action };
  }

  /**
   * The owner decided — one action or a night's worth in one click.
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
      console.warn('[proteus] deferred-approval announce failed:',
        err instanceof Error ? err.message : err);
    }
  }
}
