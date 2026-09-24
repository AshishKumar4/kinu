/**
 * Task-lifetime agents: a full child run inside the calling tool call, answered as its result, then released, on a
 * durable hire's runtime and roster. The in-memory waiter is a fast path; the report is a `subordinate_report` event.
 */

import type { SubordinateReportStatus } from '../events/hub/types';
import { KinuError, renderCauseChain, toKinuError, type ErrorCode } from '../obs/error';
import type { SubordinateRosterStore } from './roster';
import type { SubordinateRuntime } from './support';
import { finishSubordinateBirth, type SubordinateBirth } from './birth';
import { codenameFor } from '../identity/naming';
import {
  TEMPORARY_LIFETIME,
  subordinateBirthContext,
  type TemporaryAgentPort, type TemporaryRunOutcome,
} from '../types/subordinates';

export {
  TEMPORARY_LIFETIME,
  type TemporaryAgentPort, type TemporaryRunOutcome,
  type TemporaryRunRefusal, type TemporaryRunRequest,
} from '../types/subordinates';

/** How long a roster row lives; a column because task and durable rows are indistinguishable by state. */
export const SUBORDINATE_LIFETIMES = ['durable', 'task'] as const;

export type SubordinateLifetime = (typeof SUBORDINATE_LIFETIMES)[number];

/** How a task child's turn ended. The set must stay closed: the caller blocks on exactly one report. */
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

/** The report a child's settled turn owes its caller. */
export interface OwedReport {
  readonly status: SubordinateReportStatus;
  readonly content: string;
}

/** How a turn ended, as a task child's caller hears it. */
export function taskTurnEnding(completed: boolean, interrupted: boolean): TaskTurnEnding {
  if (completed) return 'answered';

  return interrupted ? 'interrupted' : 'errored';
}

/** A task child's one report per ending: `completed` for an answer, else `blocked`; null for a durable child. */
export async function terminalTaskReport(input: {
  readonly lifetime: SubordinateLifetime;
  readonly ending: TaskTurnEnding;
  /** The child's own closing words, when it had any. */
  readonly assistantText: string;
  /** Each step's words, oldest first; read only for a task that did not answer. */
  readonly narration: () => Promise<readonly string[]>;
}): Promise<OwedReport | null> {
  if (input.lifetime !== TEMPORARY_LIFETIME) return null;
  const text = input.assistantText.trim();

  if (input.ending === 'answered') {
    // An empty `answered` is `silent`: the content decides.
    return text.length > 0
      ? { status: 'completed', content: text }
      : { status: 'blocked', content: TASK_ENDING_REPORT.silent };
  }

  // A stopped or failed turn often found something on the way.
  const said: string[] = [];

  for (const step of await input.narration()) {
    const words = step.trim();

    if (words.length > 0 && words !== said.at(-1)) said.push(words);
  }

  if (text.length > 0 && !said.includes(text)) said.push(text);

  return { status: 'blocked', content: [...said, TASK_ENDING_REPORT[input.ending]].join('\n\n') };
}

/**
 * Whether this report ends the run. Shared by the port's `settle` and the roster's
 * `applyReport`; only a deliberate mid-work note is progress.
 */
export function temporaryRunSettles(input: {
  readonly status: SubordinateReportStatus;
  readonly origin: 'report_tool' | 'turn_end';
}): boolean {
  return !(input.status === 'progress' && input.origin === 'report_tool');
}

/** A task-lifetime hire's brief: the question, the material paths, and that the next
 *  message is the whole deliverable. */
function renderTemporaryTaskBrief(input: {
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

/** Task-lifetime policy over the shared roster: it adds only the in-memory waiter and never stores the answer. */
export function createTemporaryAgentPort(deps: {
  roster: SubordinateRosterStore;
  runtime: SubordinateRuntime;
  createName(role: string): string;
  now(): number;
}): TemporaryAgentPort {
  // A task-lifetime agent receives one assignment. Its name exists before the assignment RPC can report.
  const waiters = new Map<string, (answer: TemporarySettlement) => void>();

  const registerWaiter = (name: string, signal?: AbortSignal) => {
    const { promise, resolve } = Promise.withResolvers<TemporarySettlement | 'cancelled'>();

    const cleanup = () => {
      waiters.delete(name);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      resolve('cancelled');
    };

    if (signal?.aborted) {
      onAbort();
    } else {
      waiters.set(name, (answer) => {
        cleanup();
        resolve(answer);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    return { promise, cancel: onAbort };
  };

  return {
    settle: (input) => {
      const entry = deps.roster.get(input.name);

      // Only a task-lifetime row's report is a return value; durable reports stay parent events.
      if (!entry || entry.lifetime !== TEMPORARY_LIFETIME) return false;

      if (input.taskEventId !== entry.taskEventId) return false;

      if (!temporaryRunSettles(input)) return false;
      const waiter = waiters.get(input.name);

      if (!waiter) return false;
      waiter({ status: input.status, content: input.content });

      return true;
    },

    run: async (request) => {
      const task = request.task.trim();

      if (!task) return { reason: 'bad_input', error: 'hire requires a non-empty mission' };
      const refs = request.contextRefs ?? [];
      const roleLabel = request.roleLabel.trim();

      if (!roleLabel) return { reason: 'bad_input', error: 'hire requires a role' };
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

      /** Archive the row and retire the actor; history is always kept. */
      const release = async (): Promise<void> => {
        const actor = deps.roster.requireExisting(name).actorReference;

        if (!actor) throw new KinuError('missing', 'The temporary actor has no confirmed identity.');
        deps.roster.dismiss(name, deps.now());
        await deps.runtime.dismiss(name, true, actor);
      };

      const creationId = crypto.randomUUID();

      const assignment: NonNullable<SubordinateBirth['assignment']> = {
        body: renderTemporaryTaskBrief({ task, contextRefs: refs }), mode: request.mode,
      };

      const inherited = subordinateBirthContext(request.inheritedContext);

      if (inherited) assignment.inheritedContext = inherited;

      if (deps.roster.get(name)) return failure('denied', 'The generated actor name is already in use.', 'none');
      deps.roster.create({
        name, actorReference: null, deleteRequested: false,
        birth: { creationId, assignment, seed: { name, displayName: codenameFor(name), nameOrigin: 'auto', role: request.role, mission: task, lifetime: TEMPORARY_LIFETIME } },
        createdBy: 'orchestrator', status: 'working', currentTask: task, createdAt: startedAt,
        dismissedAt: null, lifetime: TEMPORARY_LIFETIME, taskEventId: null,
      });
      // A child can report before its assignment acknowledgement returns.
      const waiter = registerWaiter(name, request.signal);

      try {
        await finishSubordinateBirth(deps.roster, deps.runtime, name);
      } catch (cause) {
        waiter.cancel();
        const error = toKinuError({ doing: 'completing an admitted temporary actor birth', cause, otherwise: 'unavailable' });

        return failure(error.code, renderCauseChain(error));
      }

      const settlement = await waiter.promise;
      await release();

      if (settlement === 'cancelled') {
        return failure('cancelled', 'the caller cancelled this hire before the agent answered.');
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
