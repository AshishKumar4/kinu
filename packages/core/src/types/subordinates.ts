/** The temporary-agent port and its run contract, declared at the platform
 *  layer: the events ingress hands reports to a waiting run and the
 *  subordinates plane implements the port. */

import type { ErrorCode } from '../obs/error';
import type { SubordinateReportStatus } from '../events/hub/types';
import type { WorkMode } from './turn';
import type { RoleId } from './profile';

/** The lifetime a task-lifetime hire is listed under. */
export const TEMPORARY_LIFETIME = 'task';

/** What a caller hands the port for one temporary run. */
export interface TemporaryRunRequest {
  /** The child's role, already resolved by the caller's profile authority. */
  readonly role: RoleId;
  /** The role as one label — what the roster shows and the name derives from. */
  readonly roleLabel: string;
  readonly task: string;
  /**
   * Workspace paths the child reads ITSELF, named in its brief.
   *
   * PROGRAMMATIC CALLERS ONLY. The model-facing field this used to mirror is
   * gone: a task-lifetime hire shares this workspace's file plane, so naming a
   * path in the question is already enough, and the preflight that used to
   * authorize the paths here only duplicated the refusal the child's own file
   * read produces — one round trip earlier and one agent further from the
   * error. What remains is for callers that ASSEMBLE the list rather than
   * typing it: `evolution/refinement-lane.ts` fills it from what the workspace
   * actually holds, and renders it as "Files you may read yourself".
   */
  readonly contextRefs?: readonly string[];
  readonly mode: WorkMode;
  readonly signal?: AbortSignal;
}

/**
 * WHAT A ROLE-TARGETED ASK RETURNS — one shape, always, once the child exists.
 *
 * A caller that has to branch on which of three shapes came back cannot write
 * the loop this rung is for. So the fields are the same whether the child
 * answered, failed, or was cancelled, and `status` is what differs; `reason`
 * rides along only on a failure, in the same classified vocabulary every other
 * refusal on this surface uses (obs/error.ts).
 *
 * `transcript` is deliberately not a path. What survives a release is the child
 * ACTOR and its own history, addressed by the name in this result — so the
 * honest field says the transcript was kept and names the agent that holds it,
 * rather than inventing a URI whose reader does not exist.
 *
 * The model-facing list resolves an archived roster row without reopening it.
 * Owners read retained history and run events through the workspace inspection
 * path. Ask and send still require an active roster entry.
 */
export interface TemporaryRunOutcome {
  readonly status: 'completed' | 'failed';
  readonly agent: string;
  readonly lifetime: typeof TEMPORARY_LIFETIME;
  readonly role: string;
  /** The child's single settled answer, or why there is none. */
  readonly answer: string;
  /**
   * Whether an actor survives this result to be read back.
   *
   * Releasing a temporary agent keeps its history. Owners inspect that history
   * by its subordinate path. `none` means the child was never created.
   */
  readonly transcript: 'kept' | 'none';
  readonly elapsed_ms: number;
  readonly reason?: ErrorCode;
}

/**
 * A refusal RAISED BEFORE THE CHILD EXISTS — the only shape a task-lifetime hire
 * returns that is not {@link TemporaryRunOutcome}, and not an exception to "one
 * stable shape": there is no agent yet to report on, so an outcome naming one
 * would be a fiction.
 */
export interface TemporaryRunRefusal {
  readonly reason: ErrorCode;
  readonly error: string;
}

/**
 * The temporary-agent port: the run policy plus the live waiters.
 *
 * No `active()` and no `history()`, deliberately. Both questions are answered by
 * the ONE roster — `agents.list` shows every active row with its `lifetime`, and
 * a released row is the archived row the same roster already keeps — so a
 * listing method here would be a second read model over the same state.
 *
 * OPTIONAL IN THE TYPE, REQUIRED IN EFFECT wherever a backend wires a roster: an
 * actor without it has no `lifetime` field in its schema, in its codemode
 * namespace or in its prompt, so absence is structural rather than a runtime
 * refusal.
 */
export interface TemporaryAgentPort {
  /**
   * Provision a child, run it to its single answer, release it.
   *
   * THE WAIT HAS NO ELAPSED BOUND, by the same ruling `PeerHub.ask` carries and
   * by this engine's rule that a delegation is never deadlined: it ends when the
   * answer arrives or when the caller's `signal` fires. There is no timer here
   * and there must not be one — a temporary agent doing real work must not be
   * cut off by a clock, and a clock is not what makes the wait terminate.
   *
   * WHAT MAKES IT TERMINATE is the child: a `lifetime:'task'` child emits exactly
   * ONE run-SETTLING report for every way its turn can end — a finished answer, a
   * finished turn with nothing to say, a block, an error, an interruption, and a
   * terminal state recovered after a restart (`terminalTaskReport`).
   *
   * Exactly one, and the counting is the subtle half. A child may also file a
   * mid-task `progress` note, which is NOT the answer
   * ({@link temporaryRunSettles}) and must therefore not discharge what it owes
   * — suppressing the terminal report on "the child spoke this turn" rather than
   * on "the child already answered" is precisely how a task hire came to park forever.
   * Both backends track the two facts separately for that reason.
   *
   * So silence is not a reachable state rather than a bounded one, which is the
   * only honest way to have no deadline.
   */
  run(request: TemporaryRunRequest): Promise<TemporaryRunOutcome | TemporaryRunRefusal>;
  /**
   * Hand one arriving report to the run waiting on it, and say whether anything
   * was waiting.
   *
   * FALSE is the load-bearing answer: it means this report has no live caller,
   * so the ingress publishes it as the ordinary correlated `subordinate_report`
   * event. That is what makes an evicted activation lose the return VALUE and
   * nothing else.
   */
  settle(input: {
    readonly name: string;
    /** The assignment id this row is working on, from the roster row. */
    readonly taskEventId: string | null;
    readonly status: SubordinateReportStatus;
    readonly content: string;
    readonly origin: 'report_tool' | 'turn_end';
  }): boolean;
}
