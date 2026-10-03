/**
 * Task-lifetime agents on a durable hire's runtime and roster: started at once; the settling report wakes the hirer.
 */

import type { SubordinateReportStatus } from '../events/hub/types';
import type { EventLog } from '../events/hub/log';
import { Cause, Effect } from 'effect';
import { settle } from '../obs/effect';
import { renderCauseChain, toKinuError, type ErrorCode } from '../obs/error';
import type { SubordinateRosterStore } from './roster';
import type { SubordinateRuntime } from './support';
import { finishSubordinateBirth, type SubordinateBirth } from './birth';
import { codenameFor } from '../identity/naming';
import type { ActorReference } from '../identity/actor-handle';
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

/** How long a roster row lives; state cannot tell the two apart. */
export const SUBORDINATE_LIFETIMES = ['durable', 'task'] as const;

export type SubordinateLifetime = (typeof SUBORDINATE_LIFETIMES)[number];

/** Later while a hire works, input is queued, or a settled hire's report waits unread. An evolution helper (the
 *  turn's advisor) answers the runtime, never this turn, so it holds nothing. */
export function taskAnswerIsLater(input: {
  readonly roster: SubordinateRosterStore;
  readonly log: EventLog;
  readonly turnTaskId?: string;
}): boolean {
  return input.roster.list().some((hire) => hire.status === 'working' && hire.origin !== 'evolution')
    || input.log.pending({ variant: 'subordinate_task' }).some((row) => row.id !== input.turnTaskId)
    || input.log.pending({ variant: 'subordinate_report' }).length > 0;
}

/** How a task child's turn ended. The set must stay closed: the hirer is owed exactly one report. */
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

export interface OwedReport {
  readonly status: SubordinateReportStatus;
  readonly content: string;
  /** A Stop: settles the row, wakes no one. */
  readonly quiet?: true;
}

/** How a turn ended, as a task child's caller hears it. */
export function taskTurnEnding(completed: boolean, interrupted: boolean): TaskTurnEnding {
  if (completed) return 'answered';

  return interrupted ? 'interrupted' : 'errored';
}

/** A child's terminal report: a task answer, any failure, a quiet Stop; null for a durable answer. */
export async function terminalTaskReport(input: {
  readonly lifetime: SubordinateLifetime;
  readonly ending: TaskTurnEnding;
  readonly assistantText: string;
  /** Each step's words, oldest first; read only for a task that did not answer. */
  readonly narration: () => Promise<readonly string[]>;
  /** A later turn's reply is its answer ({@link taskAnswerIsLater}). */
  readonly delegating?: boolean;
}): Promise<OwedReport | null> {
  const text = input.assistantText.trim();

  if (input.ending === 'answered' && (input.lifetime !== TEMPORARY_LIFETIME || input.delegating === true)) return null;

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

  const content = [...said, TASK_ENDING_REPORT[input.ending]].join('\n\n');

  return input.ending === 'interrupted' ? { status: 'blocked', content, quiet: true } : { status: 'blocked', content };
}

/** Whether this report ends the run; only a deliberate mid-work note is progress. */
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
      'Material for this question, by workspace path: read it yourself, in ranges when it is '
      + `large: ${input.contextRefs.join(', ')}.`,
    );
  }

  parts.push(
    'You exist for this one question. Your final reply is delivered to the agent that asked as a message, '
    + 'and there is no second exchange: put the whole finished answer in one reply, and say what '
    + 'you could not establish rather than leaving it out.',
  );

  return parts.join('\n\n');
}

/** Task-lifetime policy over the shared roster. */
export function createTemporaryAgentPort(deps: {
  roster: SubordinateRosterStore;
  runtime: SubordinateRuntime;
  createName(role: string): string;
  now(): number;
  afterTurn(child: ActorReference, work: () => Promise<void>): void;
}): TemporaryAgentPort {
  return {
    start: (request) => settle(Effect.gen(function* () {
      const task = request.task.trim();

      if (!task) return { reason: 'bad_input', error: 'hire requires a non-empty mission' };
      const refs = request.contextRefs ?? [];
      const roleLabel = request.roleLabel.trim();

      if (!roleLabel) return { reason: 'bad_input', error: 'hire requires a role' };
      const name = deps.createName(`ask-${roleLabel}`);
      const startedAt = deps.now();

      const outcome = (status: TemporaryRunOutcome['status'], answer: string, transcript: 'kept' | 'none', reason?: ErrorCode): TemporaryRunOutcome => ({
        status, agent: name, lifetime: TEMPORARY_LIFETIME, role: roleLabel, answer, transcript, ...(reason !== undefined && { reason }),
      });

      const creationId = crypto.randomUUID();

      const assignment: NonNullable<SubordinateBirth['assignment']> = {
        body: renderTemporaryTaskBrief({ task, contextRefs: refs }), mode: request.mode,
      };

      const inherited = subordinateBirthContext(request.inheritedContext);

      if (inherited) assignment.inheritedContext = inherited;

      if (deps.roster.get(name)) return outcome('failed', 'The generated actor name is already in use.', 'none', 'denied');

      if (request.lane) deps.roster.helpers.record(name, request.lane, startedAt);
      deps.roster.create({
        name, actorReference: null, deleteRequested: false,
        birth: { creationId, assignment, seed: { name, displayName: codenameFor(name), nameOrigin: 'auto', role: request.role, mission: task, lifetime: TEMPORARY_LIFETIME, origin: request.lane ? 'evolution' : 'agent' } },
        status: 'working', currentTask: task, createdAt: startedAt,
        dismissedAt: null, lifetime: TEMPORARY_LIFETIME, taskEventId: null,
      });

      const failure = yield* Effect.catchCause(Effect.as(Effect.promise(() => finishSubordinateBirth(deps.roster, deps.runtime, name)), null), (failed) => Effect.succeed(
        toKinuError({ doing: 'completing an admitted temporary actor birth', cause: Cause.squash(failed), otherwise: 'unavailable' }),
      ));

      if (failure !== null) return outcome('failed', renderCauseChain(failure), 'kept', failure.code);

      return outcome('working', TEMPORARY_ANSWER_ARRIVES, 'kept');
    })),

    release: (name) => {
      const actor = deps.roster.get(name)?.actorReference;

      if (!actor) return;
      deps.roster.dismiss(name, deps.now());
      deps.afterTurn(actor, () => deps.runtime.dismiss(name, { keepHistory: true, interrupt: false }, actor));
    },

    reclaim: (request) => deps.roster.helpers.answerFor(request),
    answered: () => deps.roster.helpers.answered(),
    forget: (name) => { deps.roster.helpers.remove(name); },
  };
}

const TEMPORARY_ANSWER_ARRIVES = 'Working. Its answer, or why it could not answer, arrives later as a message '
  + 'that opens your next turn; end this turn when you have nothing else to do.';
