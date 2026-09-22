/** Report ingress for durable and task-lifetime children: a live waiter consumes its answer;
 *  every other admitted report enters the parent event rail. */

import type { EventLog } from '../hub/log';
import type { VFS } from '../../types/primitives';
import { spillEventContent } from '../hub/content-spill';
import { subordinateReportDedupeKey } from '../hub/dedupe';
import { renderSubordinateHandoff } from '../hub/visibility';
import type { SubordinateReportHandoff, SubordinateReportStatus } from '../hub/types';
import type { WorkMode } from '../../types/turn';
import {
  admitSubordinateReport, normalizeReportContent, parentAdmitsSubordinateReport,
  type SubordinateReportOrigin,
} from '../../subordinates/support';
import type { SubordinateRosterStore } from '../../subordinates/roster';
import type { TemporaryAgentPort } from '../../types/subordinates';

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
}

/** `already_held`: replay, nothing re-published. `not_awaited`: no open assignment, `id` empty. */
export interface SubordinateEventResult {
  readonly id: string;
  readonly disposition: 'admitted' | 'already_held' | 'not_awaited';
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

  // Before the dismissal check: a blocked waiter still wants the answer. The handoff rides as
    // trailing sections because the waiter receives one string.
  if (deps.temporary?.settle({
    name: input.fromSubordinate,
    taskEventId: subordinate.taskEventId,
    status: input.status,
    content: normalizeReportContent(input.content)
      + (input.handoff ? renderSubordinateHandoff(input.handoff) : ''),
    origin: input.origin,
  })) {
    return { id: '', disposition: 'admitted' };
  }

  if (subordinate.status === 'dismissed') {
    return { id: '', disposition: 'not_awaited' };
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

  return { id: published.id, disposition: 'admitted' };
}
