/**
 * Subordinate ingress — a delegate's progress report enters its parent's event
 * rail, the same rail mission inbox and webhooks arrive on.
 *
 * Spill → admit → roster-apply → announce → drain. The only host-shaped step is
 * the transaction the admit + roster write share: on a Durable Object that is
 * `ctx.storage.transactionSync`, and a backend without one runs the body
 * directly.
 */

import type { EventLog } from '../hub/log';
import type { VFS } from '../../types/primitives';
import { spillEventContent } from '../hub/content-spill';
import type { SubordinateReportStatus } from '../hub/types';
import type { WorkMode } from '../../prompting/surface';
import {
  admitSubordinateReport, normalizeReportContent, parentAdmitsSubordinateReport,
  type SubordinateReportOrigin, type SubordinateRosterStore,
} from '../../subordinates/support';

export interface SubordinateEventInput {
  fromSubordinate: string;
  status: SubordinateReportStatus;
  content: string;
  origin: SubordinateReportOrigin;
  mode: WorkMode;
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
}

/** Accept one report from a subordinate this agent owns. */
export async function receiveSubordinateEvent(
  deps: SubordinateIngressDeps,
  input: SubordinateEventInput,
  now: number,
): Promise<{ id: string; admitted: boolean }> {
  const subordinate = deps.roster.get(input.fromSubordinate);
  if (!subordinate || subordinate.status === 'dismissed') {
    throw new Error(`unknown subordinate "${input.fromSubordinate}"`);
  }
  // Before the spill: a relay this workspace is not the audience for must not
  // leave a file behind on its file plane either. No event exists, so no id.
  if (!parentAdmitsSubordinateReport({ entry: subordinate })) {
    return { id: '', admitted: false };
  }
  // Before the transaction: the VFS write is async, admission is not.
  const content = normalizeReportContent(input.content);
  const contentPath = await spillEventContent(deps.vfs, content);
  const result = deps.transaction(() => {
    const published = admitSubordinateReport(deps.log, {
      fromSubordinate: input.fromSubordinate,
      status: input.status,
      content,
      mode: input.mode,
      task: subordinate.currentTask ?? undefined,
      contentPath: contentPath || undefined,
      now,
    });
    if (published.admitted) {
      deps.roster.applyReport(input.fromSubordinate, input.status);
    }
    return published;
  });
  if (result.admitted) {
    deps.announce({
      id: result.id,
      subordinate: input.fromSubordinate,
      status: input.status,
      content: input.content,
      task: subordinate.currentTask ?? undefined,
      timestamp: now,
    });
    deps.onAdmitted();
  }
  return result;
}
