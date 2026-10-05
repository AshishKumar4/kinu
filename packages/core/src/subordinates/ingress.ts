import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Report ingress for durable and task-lifetime children: a live waiter consumes its answer;
 *  every other admitted report enters the parent event rail, except an evolution helper's. */

import type { EventLog } from '../events/hub/log';

import { spillEventContent } from '../events/hub/content-spill';
import { subordinateReportDedupeKey } from '../events/hub/dedupe';
import { renderSubordinateHandoff } from '../events/hub/visibility';
import type { SubordinateReportHandoff, SubordinateReportStatus } from '../events/hub/types';
import type { WorkMode } from '../types/turn';
import {
  admitSubordinateReport, normalizeReportContent, parentAdmitsSubordinateReport,
  type SubordinateReportOrigin,
} from './support';
import type { SubordinateRosterStore } from './roster';
import { TEMPORARY_LIFETIME, temporaryRunSettles } from './temporary';
import type { TemporaryAgentPort } from '../types/subordinates';

export interface SubordinateEventInput {
  fromSubordinate: string;
  status: SubordinateReportStatus;
  content: string;
  origin: SubordinateReportOrigin;
  /** The idempotency key. */
  sequenceId: string;
  /** Travels with the report: a replay settles after the child's turn metadata is gone. */
  mode: WorkMode;
  /** Absent on the automatic turn-end relay. */
  handoff?: SubordinateReportHandoff;
  /** A Stop: wakes no one. */
  quiet?: true;
}

/** `already_held`: replay, nothing re-published. `not_awaited`: no open assignment, `id` empty. */
export interface SubordinateEventResult {
  readonly id: string;
  readonly disposition: 'admitted' | 'already_held' | 'not_awaited';
}

/**
 * What a child's turn has told its hirer so far. `spoke` (durable relay policy) and `settled` (temporary rung answered)
 * are distinct: a `progress` note speaks without settling, and conflating them suppressed the terminal report of an ask.
 */
export interface SubordinateReportLedger {
  spoke: boolean;
  settled: boolean;
}

/** The one report publisher: both report sources, its report tool and its turn's end, carry the admitted turn's mode
 *  and update the same ledger. */
export async function publishSubordinateReport(
  turn: { readonly mode: WorkMode; readonly reports: SubordinateReportLedger | null },
  report: Omit<SubordinateEventInput, 'fromSubordinate' | 'mode'>,
  send: (report: Omit<SubordinateEventInput, 'fromSubordinate'>) => Promise<SubordinateEventResult>,
): Promise<SubordinateEventResult> {
  const result = await send({ ...report, mode: turn.mode });

  if (turn.reports !== null) {
    turn.reports.spoke = true;
    turn.reports.settled ||= temporaryRunSettles({ status: report.status, origin: report.origin });
  }

  return result;
}

export interface AdmittedSubordinateReport {
  id: string;
  subordinate: string;
  status: SubordinateReportStatus;
  content: string;
  task?: string;
  timestamp: number;
}

export interface SubordinateIngressDeps {
  log: EventLog;
  roster: SubordinateRosterStore;
  vfs: VFS;
  transaction<T>(body: () => T): T;
  announce(report: AdmittedSubordinateReport): void;
  onAdmitted(): void;
  /** Inside the transaction that stores an evolution helper's answer: a host with a durable job queue writes the
   *  delivery job here, so the answer and its job land or vanish together; what it returns is awaited after the
   *  commit (the queue's alarm re-arm). A host without one returns nothing: its stored answer is the owed delivery. */
  evolutionAnswerStored(): Promise<void> | undefined;
  /** After the answer is stored; a host with no durable job queue delivers the advisor's answer here. */
  onEvolutionAnswer(): void | Promise<void>;
  temporary?: TemporaryAgentPort;
}

export async function receiveSubordinateEvent(
  deps: SubordinateIngressDeps,
  input: SubordinateEventInput,
  now: number,
): Promise<SubordinateEventResult> {
  // Before every other check, including the roster: the rail is the only witness that survives the
  // child's crash, and re-answering a replay would leave the child's row owed forever.
  const held = deps.log.idForDedupeKey(subordinateReportDedupeKey(input.sequenceId));

  if (held !== null) return { id: held, disposition: 'already_held' };
  const subordinate = deps.roster.get(input.fromSubordinate);

  // `not_awaited` settles the child's row; throwing would make it retry forever.
  if (!subordinate) {
    return { id: '', disposition: 'not_awaited' };
  }

  const answer = normalizeReportContent(input.content)
    + (input.handoff ? renderSubordinateHandoff(input.handoff) : '');

  const settlesTask = subordinate.lifetime === TEMPORARY_LIFETIME && temporaryRunSettles(input);

  // A rail row would wake the parent in the helper's mode, with the lane's proposal in its context.
  if (subordinate.origin === 'evolution') {
    if (subordinate.status === 'dismissed' || !temporaryRunSettles(input)) {
      return { id: '', disposition: 'not_awaited' };
    }

    const queued = deps.transaction(() => {
      deps.roster.helpers.storeAnswer(input.fromSubordinate, input.status === 'blocked' ? 'blocked' : 'completed', answer);
      deps.roster.applyReport(input.fromSubordinate, input.status, input.origin, now);

      return deps.evolutionAnswerStored();
    });

    await queued;
    await deps.onEvolutionAnswer();
    deps.temporary?.release(input.fromSubordinate);

    return { id: '', disposition: 'admitted' };
  }

  if (subordinate.status === 'dismissed') {
    return { id: '', disposition: 'not_awaited' };
  }

  if (input.quiet === true) {
    deps.transaction(() => { deps.roster.applyReport(input.fromSubordinate, input.status, input.origin, now); });

    if (settlesTask) deps.temporary?.release(input.fromSubordinate);

    return { id: '', disposition: 'admitted' };
  }

  // Before the spill, so a relay this workspace does not admit leaves no file behind.
  if (!parentAdmitsSubordinateReport({ entry: subordinate })) {
    return { id: '', disposition: 'not_awaited' };
  }

  const content = normalizeReportContent(input.content);
  const spilled = await spillEventContent(deps.vfs, content);

  const published = deps.transaction(() => {
    const result = admitSubordinateReport(deps.log, {
      fromSubordinate: input.fromSubordinate,
      status: input.status,
      content,
      sequenceId: input.sequenceId,
      mode: input.mode,
      task: subordinate.currentTask ?? undefined,
      spilled: spilled ?? undefined,
      handoff: input.handoff,
      now,
    });

    if (result.admitted) {
      deps.roster.applyReport(input.fromSubordinate, input.status, input.origin, now);
    }

    return result;
  });

  // Lost the race on the unique dedupe key.
  if (!published.admitted) return { id: published.id, disposition: 'already_held' };
  deps.announce({
    id: published.id,
    subordinate: input.fromSubordinate,
    status: input.status,
    content: input.content,
    task: subordinate.currentTask ?? undefined,
    timestamp: now,
  });
  deps.onAdmitted();

  if (settlesTask) deps.temporary?.release(input.fromSubordinate);

  return { id: published.id, disposition: 'admitted' };
}
