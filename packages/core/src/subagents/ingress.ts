import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
/** Report ingress for durable and task-lifetime children: a live waiter consumes its answer;
 *  every other admitted report enters the parent event rail, except an evolution subagent's. */

import type { EventLog } from '../events/hub/log';

import { spillEventContent } from '../events/hub/content-spill';
import { subagentReportDedupeKey } from '../events/hub/dedupe';
import type { SubagentReportHandoff, SubagentReportStatus } from '../events/hub/types';
import type { WorkMode } from '../types/turn';
import {
  admitSubagentReport, normalizeReportContent, parentAdmitsSubagentReport,
  type SubagentReportOrigin,
} from './support';
import type { SubagentRosterStore } from './roster';
import { TEMPORARY_LIFETIME, temporaryRunSettles } from './temporary';
import type { TemporaryAgentPort } from '../types/subagents';

export interface SubagentEventInput {
  fromSubagent: string;
  status: SubagentReportStatus;
  content: string;
  origin: SubagentReportOrigin;
  /** The idempotency key. */
  sequenceId: string;
  /** Travels with the report: a replay settles after the child's turn metadata is gone. */
  mode: WorkMode;
  /** Absent on the automatic turn-end relay. */
  handoff?: SubagentReportHandoff;
  /** A Stop: wakes no one. */
  quiet?: true;
}

/** `already_held`: replay, nothing re-published. `not_awaited`: no open assignment, `id` empty. */
export interface SubagentEventResult {
  readonly id: string;
  readonly disposition: 'admitted' | 'already_held' | 'not_awaited';
}

/**
 * What a child's turn has told its hirer so far. `spoke` (durable relay policy) and `settled` (temporary rung answered)
 * are distinct: a `progress` note speaks without settling, and conflating them suppressed the terminal report of an ask.
 */
export interface SubagentReportLedger {
  spoke: boolean;
  settled: boolean;
}

/** The one report publisher: both report sources, its report tool and its turn's end, carry the admitted turn's mode
 *  and update the same ledger. */
export async function publishSubagentReport(
  turn: { readonly mode: WorkMode; readonly reports: SubagentReportLedger | null },
  report: Omit<SubagentEventInput, 'fromSubagent' | 'mode'>,
  send: (report: Omit<SubagentEventInput, 'fromSubagent'>) => Promise<SubagentEventResult>,
): Promise<SubagentEventResult> {
  const result = await send({ ...report, mode: turn.mode });

  if (turn.reports !== null) {
    turn.reports.spoke = true;
    turn.reports.settled ||= temporaryRunSettles({ status: report.status, origin: report.origin });
  }

  return result;
}

export interface AdmittedSubagentReport {
  id: string;
  subagent: string;
  status: SubagentReportStatus;
  content: string;
  task?: string;
  timestamp: number;
}

export interface SubagentIngressDeps {
  log: EventLog;
  roster: SubagentRosterStore;
  vfs: VFS;
  transaction<T>(body: () => T): T;
  announce(report: AdmittedSubagentReport): void;
  onAdmitted(): void;
  temporary?: TemporaryAgentPort;
}

export async function receiveSubagentEvent(
  deps: SubagentIngressDeps,
  input: SubagentEventInput,
  now: number,
): Promise<SubagentEventResult> {
  // Before every other check, including the roster: the rail is the only witness that survives the
  // child's crash, and re-answering a replay would leave the child's row owed forever.
  const held = deps.log.idForDedupeKey(subagentReportDedupeKey(input.sequenceId));

  if (held !== null) return { id: held, disposition: 'already_held' };
  const subagent = deps.roster.get(input.fromSubagent);

  // `not_awaited` settles the child's row; throwing would make it retry forever.
  if (!subagent) {
    return { id: '', disposition: 'not_awaited' };
  }

  const settlesTask = subagent.lifetime === TEMPORARY_LIFETIME && temporaryRunSettles(input);

  // An evolution subagent an earlier build hired answers no one now: a rail row would wake its hirer in its mode, with
  // its answer in the hirer's context. It settles and is released, its answer unread.
  if (subagent.origin === 'evolution') {
    if (subagent.status === 'dismissed' || !temporaryRunSettles(input)) {
      return { id: '', disposition: 'not_awaited' };
    }

    deps.transaction(() => { deps.roster.applyReport(input.fromSubagent, input.status, input.origin, now); });
    deps.temporary?.release(input.fromSubagent);

    return { id: '', disposition: 'admitted' };
  }

  if (subagent.status === 'dismissed') {
    return { id: '', disposition: 'not_awaited' };
  }

  // Before the spill, so a relay this workspace does not admit leaves no file behind; and before a Stop's quiet report,
  // which settles only a row its parent awaits: the owner's Stop in their own chat, which awaits nothing, marked that
  // chat as waiting on them for good (production, 2026-10-08).
  if (!parentAdmitsSubagentReport({ entry: subagent })) {
    return { id: '', disposition: 'not_awaited' };
  }

  if (input.quiet === true) {
    deps.transaction(() => { deps.roster.applyReport(input.fromSubagent, input.status, input.origin, now); });

    if (settlesTask) deps.temporary?.release(input.fromSubagent);

    return { id: '', disposition: 'admitted' };
  }

  const content = normalizeReportContent(input.content);
  const spilled = await spillEventContent(deps.vfs, content);

  const published = deps.transaction(() => {
    const result = admitSubagentReport(deps.log, {
      fromSubagent: input.fromSubagent,
      status: input.status,
      content,
      sequenceId: input.sequenceId,
      mode: input.mode,
      task: subagent.currentTask ?? undefined,
      spilled: spilled ?? undefined,
      handoff: input.handoff,
      now,
    });

    if (result.admitted) {
      deps.roster.applyReport(input.fromSubagent, input.status, input.origin, now);
    }

    return result;
  });

  // Lost the race on the unique dedupe key.
  if (!published.admitted) return { id: published.id, disposition: 'already_held' };
  deps.announce({
    id: published.id,
    subagent: input.fromSubagent,
    status: input.status,
    content: input.content,
    task: subagent.currentTask ?? undefined,
    timestamp: now,
  });
  deps.onAdmitted();

  if (settlesTask) deps.temporary?.release(input.fromSubagent);

  return { id: published.id, disposition: 'admitted' };
}
