/**
 * TEMPORARY AGENTS — one full child agent, run to completion inside the call
 * that asked for it, and released when it answers.
 *
 * `agents({action:'ask', role, message})` is the third lifetime on the one
 * delegation ladder, and the only one whose answer arrives as the tool RESULT.
 * A `hire` is durable and stays; an `ask` to an existing agent is a handoff
 * whose report wakes the caller turns later; a role-targeted `ask` creates an
 * agent for exactly this question, waits for its single answer, and retires it.
 *
 * IT IS THE SAME CHILD, IN THE SAME ROSTER. There is no second child substrate,
 * no second loop, no second facet builder — and no second table. A temporary run
 * is provisioned through the very {@link SubordinateRuntime} a hire goes
 * through, and it is booked in `workspace_subordinates` like every other helper.
 * What distinguishes it there is ONE non-derivable column, `lifetime`, plus the
 * `task_event_id` of the assignment it is working on:
 *
 *   lifetime='task'   — listed while it works, and RELEASED (archived, history
 *                       kept) the moment it answers. A durable row with an open
 *                       assignment is the same shape; only the lifetime says
 *                       which of them is retired on the answer.
 *   task_event_id     — the EventLog id of the open assignment, which is the id
 *                       the report cites. Correlation is therefore the one this
 *                       surface already documents (`SubordinateHandoff.eventId`)
 *                       rather than a private scheme beside it.
 *
 * DURABILITY IS THE EVENT LOG AND THE CHILD'S OWN TRANSCRIPT — not a mirror.
 * The assignment is a `subordinate_task` event; the answer is a
 * `subordinate_report`; the working record is the child actor's own history,
 * which a release keeps. The in-memory waiter is only the fast path that lets
 * the asking call return the answer directly: WITH a live waiter the report is
 * consumed inline (publishing it too would wake a turn to read an answer the
 * caller already has), and WITHOUT one — the asking activation died — it stays a
 * normal correlated `subordinate_report` event that wakes the parent, exactly
 * like any other delegated answer. Nothing is lost either way, and nothing is
 * stored twice.
 */

import type { WorkMode } from '../prompting/surface';
import type { RoleSelection } from '../config/store';
import type { SubordinateHandoff } from '../tools/agents-tool';
import type { SubordinateReportStatus } from '../events/hub/types';
import { classifyErrorCode, type ErrorCode } from '../obs/error';
import { renderThrownChain } from '../obs/index';
import type { SubordinateRosterStore } from './roster';
import type { SubordinateRuntime } from './support';

/**
 * How long a roster row is meant to live. The one non-derivable fact a
 * role-targeted ask adds to the roster, and the reason it is a column rather
 * than an inference: a task-lifetime row working on its question and a durable
 * row working on an assignment are indistinguishable by state.
 */
export const SUBORDINATE_LIFETIMES = ['durable', 'task'] as const;
export type SubordinateLifetime = (typeof SUBORDINATE_LIFETIMES)[number];

/** The lifetime a temporary agent is listed under. */
export const TEMPORARY_LIFETIME = 'task';


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
 * That name RESOLVES: `agents({action:'list', agent})` serves the archived row
 * and the child's own state, because the detail lookup asks the roster whether it
 * KNOWS the name rather than whether it is still in the working set
 * (`TeamToolDeps.knows`). Archived rows are readable and never addressable — the
 * ask and send arms still route on the active roster, so nothing released can be
 * handed new work.
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
   * `kept` for every agent that RAN: releasing a temporary agent never wipes its
   * history, and the `agent` above resolves through `agents({action:'list',
   * agent})`. `none` only where the child was never born — a spawn that failed
   * leaves nothing to keep, and saying `kept` there would name a transcript that
   * does not exist. Same keys either way; the value is what differs.
   */
  readonly transcript: 'kept' | 'none';
  readonly elapsed_ms: number;
  readonly reason?: ErrorCode;
}

/**
 * A refusal RAISED BEFORE THE CHILD EXISTS — the only shape a role-targeted ask
 * returns that is not {@link TemporaryRunOutcome}, and not an exception to "one
 * stable shape": there is no agent yet to report on, so an outcome naming one
 * would be a fiction.
 */
export interface TemporaryRunRefusal {
  readonly reason: ErrorCode;
  readonly error: string;
}

/** What a caller hands the port for one temporary run. */
export interface TemporaryRunRequest {
  /** The child's role, already resolved by the caller's profile authority. */
  readonly role: RoleSelection;
  /** The role as one label — what the roster shows and the name derives from. */
  readonly roleLabel: string;
  readonly task: string;
  /**
   * Workspace paths the child reads ITSELF.
   *
   * The bytes never enter the asking agent's window: this side only authorizes
   * the paths against the workspace file plane and names them in the child's
   * brief. That is the whole point of the channel — material a parent does not
   * need to look at should not cost the parent its context to ask about.
   */
  readonly contextRefs?: readonly string[];
  readonly mode: WorkMode;
  readonly signal?: AbortSignal;
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
 * actor without it has no role-targeted ask in its schema, in its codemode
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
   * on "the child already answered" is precisely how an ask came to park forever.
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

/**
 * HOW A TASK CHILD'S TURN ENDED, in the vocabulary the report carries.
 *
 * Named per END STATE rather than passed as free text, because the whole
 * guarantee rests on the set being CLOSED: a temporary agent's caller is
 * blocked on one report, so a terminal state with no entry here is a caller
 * that waits forever. The compiler holds the map total, so a new end state
 * cannot reach a child without a decision about what it reports.
 */
export const TASK_TURN_ENDINGS = [
  'answered',
  'silent',
  'blocked',
  'errored',
  'interrupted',
  'recovered',
] as const;
export type TaskTurnEnding = (typeof TASK_TURN_ENDINGS)[number];

/** What a task child reports for one end state. `null` for `answered`, whose
 *  content is the child's own words and never this module's. */
const TASK_ENDING_REPORT = {
  answered: null,
  silent:
    'This turn ended without producing an answer. Nothing was established, and no partial '
    + 'result is being reported as one.',
  blocked:
    'Blocked: this agent could not get far enough to answer, and the blocking condition is '
    + 'described above or in its own transcript.',
  errored:
    'This turn failed before an answer existed. The failure is recorded on this agent\'s own '
    + 'transcript; nothing here is a partial answer.',
  interrupted:
    'This turn was interrupted before an answer existed. Whatever work it had done is on this '
    + 'agent\'s own transcript.',
  recovered:
    'This agent was restarted while working and its turn did not survive. No answer was '
    + 'produced; its transcript holds what it had done.',
} as const satisfies Record<TaskTurnEnding, string | null>;

/**
 * THE ONE REPORT A TASK CHILD OWES ITS CALLER, for every way a turn can end.
 *
 * This exists because the temporary rung's caller is BLOCKED on a report, which
 * a durable subordinate's caller never is. The durable relay policy is
 * deliberately selective — `subordinateRelaysTurnEnd` withholds an owner-driven
 * turn and an empty one, because an answer nobody asked for is not progress —
 * and applying that selectivity to a task child turned three ordinary endings
 * (a provider error, an interruption, a turn that finished with nothing to say)
 * into an ask that never returned.
 *
 * So the rule inverts for this lifetime: a task child ALWAYS reports, exactly
 * once, and the status is what differs. `completed` is the answer; `blocked`
 * carries every non-answer, because from the caller's side a child that errored
 * and a child that gave up are the same event — no answer, with a reason.
 *
 * Returns null for a DURABLE child, so one call site can serve both lifetimes
 * and the durable behaviour is provably untouched.
 */
export function terminalTaskReport(input: {
  readonly lifetime: SubordinateLifetime;
  readonly ending: TaskTurnEnding;
  /** The child's own closing words, when it had any. */
  readonly assistantText: string;
}): { readonly status: SubordinateReportStatus; readonly content: string } | null {
  if (input.lifetime !== TEMPORARY_LIFETIME) return null;
  const text = input.assistantText.trim();
  if (input.ending === 'answered') {
    // An `answered` ending with nothing in it is a `silent` one that mislabelled
    // itself; the CONTENT decides, so no caller can produce an empty answer by
    // naming the wrong ending.
    return text.length > 0
      ? { status: 'completed', content: text }
      : { status: 'blocked', content: TASK_ENDING_REPORT.silent };
  }
  const reason = TASK_ENDING_REPORT[input.ending];
  // The child's own words still ride along when it managed any: a failing turn
  // often says something useful before it fails.
  return { status: 'blocked', content: text.length > 0 ? `${text}\n\n${reason}` : reason };
}

/**
 * DOES THIS REPORT END THE RUN?
 *
 * One predicate, exported, because TWO paths ask it and they must not answer
 * differently: the port's `settle` (which hands the answer to a waiting call)
 * and the roster's `applyReport` (which releases the row when nobody was
 * waiting). They disagreed once — `settle` treated a `turn_end` relay as the
 * answer while the roster released only on `completed`/`blocked`, and the
 * turn-end relay reports `progress` — so an evicted run answered by a finished
 * turn left its row listed as `working` forever.
 *
 * The rule: only a DELIBERATE mid-work note is progress. A temporary agent gets
 * one question, so everything else is its answer — a terminal report, or the
 * automatic relay of the turn that finished the work.
 */
export function temporaryRunSettles(input: {
  readonly status: SubordinateReportStatus;
  readonly origin: 'report_tool' | 'turn_end';
}): boolean {
  return !(input.status === 'progress' && input.origin === 'report_tool');
}

/**
 * A temporary agent's brief.
 *
 * Three facts, in the order they change what gets written: what it is being
 * asked, which paths hold the material, and that its NEXT MESSAGE is the whole
 * deliverable. The last one is the difference between this rung and a hire — a
 * durable subordinate can come back for more, and this one cannot, so a partial
 * first answer is the only answer.
 */
export function renderTemporaryTaskBrief(input: {
  readonly task: string;
  readonly contextRefs?: readonly string[];
}): string {
  const parts = [input.task];
  if (input.contextRefs && input.contextRefs.length > 0) {
    parts.push(
      'Material for this question, by workspace path — read it yourself, in ranges when it is '
      + `large: ${input.contextRefs.join(', ')}.`,
    );
  }
  parts.push(
    'You exist for this one question. Your answer is returned directly to the agent that asked, '
    + 'and there is no second exchange: put the whole finished answer in one reply, and say what '
    + 'you could not establish rather than leaving it out.',
  );
  return parts.join('\n\n');
}

/**
 * THE TEMPORARY-AGENT POLICY, over the SAME roster and the SAME child substrate.
 *
 * Every durable step here is one the roster and the event log already own:
 * `provision` writes the row (with `lifetime:'task'`), `runtime.assign` admits
 * the `subordinate_task` event, the report comes back through the ordinary
 * ingress, and `dismiss(keepHistory)` archives the row. This function adds
 * exactly one thing that is not already durable — the in-memory WAITER that
 * lets the asking call return the answer instead of being woken by it.
 *
 * WHICH IS WHY IT NEVER STORES THE ANSWER. The answer's durable home is the
 * child's own transcript, plus the `subordinate_report` event the ingress
 * publishes when nobody is waiting. Recording it on the parent as well would be
 * the mirror this repository deletes, and it would be the copy that goes stale.
 */
export function createTemporaryAgentPort(deps: {
  roster: SubordinateRosterStore;
  runtime: SubordinateRuntime;
  createName(role: string): string;
  now(): number;
  /**
   * The bounded conversational digest a child is handed, ALREADY RENDERED.
   *
   * Rendered by the caller rather than here, and that is what keeps this module
   * free of a runtime edge back to the orchestration policy: how much of a
   * parent's conversation a child may see is one decision
   * (`renderSubordinateInheritedContext`), owned by the module that owns every
   * other handoff rule, and this rung consumes it rather than re-deciding it.
   */
  renderInheritedContext(): string | undefined;
  /**
   * The workspace file plane one `context_ref` path is AUTHORIZED against —
   * existence only, never the bytes. Reading them here would put the material in
   * the asking agent's isolate, which is the one cost this channel exists to
   * avoid. Absent is a session with no file plane, and then a ref is refused by
   * name instead of silently ignored.
   */
  statRef?(path: string): Promise<boolean>;
}): TemporaryAgentPort {
  /** Live waiters by the ASSIGNMENT id they are waiting on — the same id the
   *  caller was handed and the report cites, so a stale row cannot resolve a
   *  newer question. */
  const waiters = new Map<string, (answer: TemporarySettlement) => void>();

  const registerWaiter = (assignmentId: () => string | null, signal?: AbortSignal) => {
    let cancel!: () => void;
    let key: string | null = null;
    const promise = new Promise<TemporarySettlement | 'cancelled'>((resolve) => {
      let finished = false;
      const cleanup = (): boolean => {
        if (finished) return false;
        finished = true;
        if (key !== null) waiters.delete(key);
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (cleanup()) resolve('cancelled');
      };
      cancel = onAbort;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      // Armed after the assignment exists, because the id IS the key. Until then
      // there is nothing to correlate against and nothing has been asked.
      key = assignmentId();
      if (key === null) return;
      waiters.set(key, (answer) => {
        if (cleanup()) resolve(answer);
      });
    });
    return { promise, cancel };
  };

  return {
    settle: (input) => {
      const entry = deps.roster.get(input.name);
      // Only a TASK-lifetime row's report is a return value. A durable
      // subordinate's report is its parent's event however it arrives, which is
      // the behaviour this rung must not touch.
      if (!entry || entry.lifetime !== TEMPORARY_LIFETIME) return false;
      if (input.taskEventId === null) return false;
      if (!temporaryRunSettles(input)) return false;
      const waiter = waiters.get(input.taskEventId);
      if (!waiter) return false;
      waiter({ status: input.status, content: input.content });
      return true;
    },

    run: async (request) => {
      const task = request.task.trim();
      if (!task) return { reason: 'bad_input', error: 'ask requires a non-empty message' };
      const refs = request.contextRefs ?? [];
      if (refs.length > 0) {
        const statRef = deps.statRef;
        if (!statRef) {
          return {
            reason: 'unavailable',
            error: 'context_ref names workspace paths and this session wired no file plane to '
              + 'authorize them against, so they could only be ignored. Put the material in '
              + '`message` instead.',
          };
        }
        const missing = (await Promise.all(refs.map(async (path) =>
          (await statRef(path)) ? null : path))).filter((path) => path !== null);
        if (missing.length > 0) {
          return {
            reason: 'missing',
            error: `context_ref paths this workspace cannot resolve: ${missing.join(', ')}. `
              + 'Nothing was sent and nothing was guessed — a helper answering about material '
              + 'it never saw is worse than this message.',
          };
        }
      }

      const roleLabel = request.roleLabel.trim();
      if (!roleLabel) return { reason: 'bad_input', error: 'ask requires a role' };
      const name = deps.createName(`ask-${roleLabel}`);
      const startedAt = deps.now();
      const failure = (
        reason: ErrorCode,
        answer: string,
        transcript: 'kept' | 'none' = 'kept',
      ): TemporaryRunOutcome => ({
        status: 'failed',
        agent: name,
        lifetime: TEMPORARY_LIFETIME,
        role: roleLabel,
        answer,
        transcript,
        elapsed_ms: deps.now() - startedAt,
        reason,
      });
      /** Archive the row and retire the actor. History is ALWAYS kept: a
       *  temporary agent is not a temporary transcript. */
      const release = async (): Promise<void> => {
        deps.roster.dismiss(name, deps.now());
        await deps.runtime.dismiss(name, true);
      };

      // Tracked rather than re-read, exactly as `rollbackSpawn` tracks it on the
      // durable path. `if (roster.get(name))` was wrong in one reachable case: if
      // `create` ITSELF threw on a primary-key collision — the generated
      // `ask-<role>-<nanoid6>` colliding with an existing row — that guard found
      // the OTHER agent's row and deleted it, orphaning a live durable
      // subordinate from the roster. Only a row THIS call wrote may be removed.
      let rosterCreated = false;
      try {
        deps.roster.create({
          name,
          createdBy: 'orchestrator',
          status: 'working',
          currentTask: task,
          createdAt: startedAt,
          dismissedAt: null,
          lifetime: TEMPORARY_LIFETIME,
          taskEventId: null,
        });
        rosterCreated = true;
        await deps.runtime.spawn({
          name,
          // Blank and `auto`: nobody named this agent, and it will not live long
          // enough for the first-interaction title policy to matter.
          displayName: '',
          nameOrigin: 'auto',
          role: request.role,
          mission: task,
          // The child's own copy of the fact its report policy turns on.
          lifetime: TEMPORARY_LIFETIME,
        });
      } catch (error) {
        // REMOVED, not archived, and that is the same call `rollbackSpawn` makes
        // on the durable path: no child was born, so there is no history to keep
        // and an archived row would name an agent that never existed.
        //
        // A cleanup that throws must not swallow what it was cleaning up after:
        // reporting only the rollback error would lose the create/spawn failure
        // that caused it, which is the single most useful fact here. Both survive,
        // in the answer, the way `rollbackSpawn` keeps both in an AggregateError.
        let cleanupError: unknown;
        if (rosterCreated) {
          try {
            deps.roster.remove(name);
          } catch (removeError) {
            cleanupError = removeError;
          }
        }
        const cause = `the temporary agent could not be created: ${renderThrownChain({ cause: error })}`;
        return failure(
          classifyErrorCode({ cause: error }) ?? 'unavailable',
          cleanupError === undefined
            ? cause
            : `${cause}\n\nIts roster row could also not be removed, so it may still be listed: `
              + renderThrownChain({ cause: cleanupError }),
          // The row survived the failed cleanup, so an actor may yet be found
          // under this name — `none` would be a claim this call cannot make.
          cleanupError === undefined ? 'none' : 'kept',
        );
      }

      let handoff: SubordinateHandoff;
      try {
        const assignment: Parameters<SubordinateRuntime['assign']>[1] = {
          body: renderTemporaryTaskBrief({ task, contextRefs: refs }),
          mode: request.mode,
        };
        const inherited = deps.renderInheritedContext();
        if (inherited) Object.assign(assignment, { inheritedContext: inherited });
        handoff = await deps.runtime.assign(name, assignment);
        deps.roster.recordAssignmentEvent(name, handoff.eventId);
      } catch (error) {
        try {
          await release();
        } catch (releaseError) {
          // Both survive, the way `rollbackSpawn` keeps both in an
          // AggregateError: reporting only the release failure would lose the
          // assignment failure that caused it, and reporting only the
          // assignment failure would lose the row that may still be listed.
          const combined = new AggregateError(
            [error, releaseError],
            'temporary agent assignment failed and its release also failed',
            { cause: error },
          );
          return failure(
            classifyErrorCode({ cause: combined }) ?? classifyErrorCode({ cause: error }) ?? 'unavailable',
            `the temporary agent was created but could not be given the work: ${renderThrownChain({ cause: error })}`
              + `\n\nIts release also failed, so the row may still be listed: ${renderThrownChain({ cause: releaseError })}`,
          );
        }
        return failure(
          classifyErrorCode({ cause: error }) ?? 'unavailable',
          `the temporary agent was created but could not be given the work: ${renderThrownChain({ cause: error })}`,
        );
      }

      // Armed AFTER the assignment, on the id the report will cite. A report
      // that beats this line has no waiter and stays a correlated event, which
      // is the same outcome an eviction produces and needs no second path.
      const waiter = registerWaiter(() => handoff.eventId, request.signal);
      const settlement = await waiter.promise;
      await release();
      if (settlement === 'cancelled') {
        return failure('cancelled', 'the caller cancelled this ask before the agent answered.');
      }
      if (settlement.status === 'blocked') return failure('unavailable', settlement.content);
      return {
        status: 'completed',
        agent: name,
        lifetime: TEMPORARY_LIFETIME,
        role: roleLabel,
        answer: settlement.content,
        transcript: 'kept',
        elapsed_ms: deps.now() - startedAt,
      };
    },
  };
}

interface TemporarySettlement {
  readonly status: SubordinateReportStatus;
  readonly content: string;
}
