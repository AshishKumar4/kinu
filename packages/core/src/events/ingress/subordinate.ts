/**
 * One roster and one report ingress for durable and task-lifetime children.
 * A live task waiter consumes its answer; every other admitted report enters
 * the parent event rail. The host supplies the admission transaction and wake.
 */

import type { EventLog } from '../hub/log';
import type { VFS } from '../../types/primitives';
import { spillEventContent } from '../hub/content-spill';
import { subordinateReportDedupeKey } from '../hub/dedupe';
import type { SubordinateReportStatus } from '../hub/types';
import type { WorkMode } from '../../prompting/surface';
import {
  admitSubordinateReport, normalizeReportContent, parentAdmitsSubordinateReport,
  type SubordinateReportOrigin,
} from '../../subordinates/support';
import type { SubordinateRosterStore } from '../../subordinates/roster';
import type { TemporaryAgentPort } from '../../subordinates/temporary';

export interface SubordinateEventInput {
  fromSubordinate: string;
  status: SubordinateReportStatus;
  content: string;
  origin: SubordinateReportOrigin;
  /** The sender's terminal sequence — this report's identity, and the key this
   *  ingress is idempotent on. */
  sequenceId: string;
  /** The mode the reported turn ran in. It TRAVELS with the report rather than
   *  being re-derived here, because a replayed report is settled long after the
   *  child's live turn metadata is gone — re-deriving it turns a Plan report
   *  into a Build one. */
  mode: WorkMode;
}

/**
 * What the parent's rail did with one arriving report.
 *
 * `already_held` is the REPLAY answer: this sequence's report is on the rail
 * from an earlier delivery, so nothing was published, applied or announced a
 * second time. The sender's owed work is done either way — the distinction is
 * what lets it say which of the two happened.
 *
 * `not_awaited` published nothing at all: the parent has no open assignment for
 * this child, so there is no event and `id` is empty.
 */
export interface SubordinateEventResult {
  readonly id: string;
  readonly disposition: 'admitted' | 'already_held' | 'not_awaited';
}

/** An admitted report, as the operator surfaces announce it. */
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
  /** The parent's file plane — an oversize report is spilled here so the
   *  drained turn reads a path, not a truncated tail. */
  vfs: VFS;
  /** Run the admit + roster write atomically. */
  transaction<T>(body: () => T): T;
  /** Announce the report to connected operator surfaces. */
  announce(report: AdmittedSubordinateReport): void;
  /** A fresh event was admitted — wake the agent loop (debounced drain). */
  onAdmitted(): void;
  /** Live task waiters. Lifetime and assignment identity come from the same roster as durable children. */
  temporary?: TemporaryAgentPort;
}

/** Accept one report from a subordinate this agent owns. */
export async function receiveSubordinateEvent(
  deps: SubordinateIngressDeps,
  input: SubordinateEventInput,
  now: number,
): Promise<SubordinateEventResult> {
  // Before EVERY other question, INCLUDING the roster. A replay must not be
  // re-answered by any of them: the roster has already moved on from the first
  // delivery — a completed report closed the assignment, an owner may have
  // dismissed the child outright — so asking those first would reject a report
  // the parent demonstrably holds and leave the child's durable row owed forever.
  // The rail itself is the only witness that survives the child's crash.
  const held = deps.log.idForDedupeKey(subordinateReportDedupeKey(input.sequenceId));
  if (held !== null) return { id: held, disposition: 'already_held' };
  const subordinate = deps.roster.get(input.fromSubordinate);
  // An unknown name is a decision the roster has already forgotten, not a
  // delivery failure. Throwing made the child retry a report nobody awaits,
  // so its terminal sequence never converged. `not_awaited` settles its row.
  if (!subordinate) {
    return { id: '', disposition: 'not_awaited' };
  }
  // A task name belongs to one assignment; its receiver exists before the assignment acknowledgement.
  // With no live receiver (including after eviction), the report continues down the event rail.

  // Asked BEFORE the dismissal below because a waiter is somebody blocked right
  // now: a row dismissed while its caller is still holding the line is exactly
  // the case where the answer is most wanted, and the durable event it does not
  // write is the only thing dismissal was protecting against.
  if (deps.temporary?.settle({
    name: input.fromSubordinate,
    taskEventId: subordinate.taskEventId,
    status: input.status,
    content: normalizeReportContent(input.content),
    origin: input.origin,
  })) {
    return { id: '', disposition: 'admitted' };
  }
  // A DISMISSED target is a decision, not a delivery failure. Throwing made the
  // child retry a report the parent has deliberately stopped awaiting, so its
  // terminal sequence never converged. `not_awaited` is the honest answer and it
  // settles the child's row.
  if (subordinate.status === 'dismissed') {
    return { id: '', disposition: 'not_awaited' };
  }
  // Before the spill: a relay this workspace is not the audience for must not
  // leave a file behind on its file plane either. No event exists, so no id.
  if (!parentAdmitsSubordinateReport({ entry: subordinate })) {
    return { id: '', disposition: 'not_awaited' };
  }
  // Before the transaction: the VFS write is async, admission is not.
  const content = normalizeReportContent(input.content);
  const contentPath = await spillEventContent(deps.vfs, content);
  const published = deps.transaction(() => {
    const result = admitSubordinateReport(deps.log, {
      fromSubordinate: input.fromSubordinate,
      status: input.status,
      content,
      sequenceId: input.sequenceId,
      mode: input.mode,
      task: subordinate.currentTask ?? undefined,
      contentPath: contentPath || undefined,
      now,
    });
    if (result.admitted) {
      deps.roster.applyReport(input.fromSubordinate, input.status, input.origin, now);
    }
    return result;
  });
  // The UNIQUE key decided it atomically, so a delivery that raced the read
  // above lands here instead of publishing beside the row it lost to.
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
