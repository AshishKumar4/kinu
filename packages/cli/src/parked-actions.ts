import { literalText, type DeferredApproval, type DeferredApprovalAnswer } from '@kinu.run/core';
import { attempt, settle, toWire, type KinuError, type Wire } from '@kinu.run/core/obs';
import type { LocalSessionControls } from './agent-client';

export const PARKED_USAGE = '/parked [approve|deny|always <id...|all>]';

function answerFor(verb: string | undefined): DeferredApprovalAnswer | null {
  switch (verb) {
    case 'approve': return 'approved';
    case 'deny': return 'denied';
    case 'always': return 'always';
    case undefined: return null;
    default: return null;
  }
}

function parkedLine(action: DeferredApproval): string {
  return `${action.id}  on ${action.executor}: ${literalText(action.command)}\n    ${literalText(action.reason)}`;
}

export function renderParked(actions: readonly DeferredApproval[]): string {
  if (actions.length === 0) return 'No commands are waiting for your approval.';

  return [
    `${String(actions.length)} command${actions.length === 1 ? '' : 's'} waiting for your approval, none run yet:`,
    ...actions.map(parkedLine),
    `Decide with ${PARKED_USAGE}.`,
  ].join('\n');
}

export function parkedDecision(
  words: readonly string[], actions: readonly DeferredApproval[],
): { readonly answer: DeferredApprovalAnswer; readonly ids: string[] } | null {
  const [verb, ...named] = words;
  const answer = answerFor(verb);

  if (answer === null || named.length === 0) return null;

  return { answer, ids: named.includes('all') ? actions.map((action) => action.id) : named };
}

function parkedNotice(actions: readonly DeferredApproval[], seen: ReadonlySet<string>): string | null {
  const fresh = actions.filter((action) => !seen.has(action.id));

  if (fresh.length === 0) return null;

  return [
    `Parked for your approval, not run: ${String(fresh.length)} command${fresh.length === 1 ? '' : 's'}.`,
    ...fresh.map(parkedLine),
    `Decide with ${PARKED_USAGE}.`,
  ].join('\n');
}

export function readParkedNotice(
  controls: Pick<LocalSessionControls, 'listDeferredApprovals'>, seen: Set<string>,
): Promise<Wire<string | null, KinuError>> {
  return settle(toWire(attempt(
    { doing: 'reading the commands parked for your approval', otherwise: 'unavailable' },
    async () => {
      const actions = await controls.listDeferredApprovals();
      const notice = parkedNotice(actions, seen);
      seen.clear();

      for (const action of actions) seen.add(action.id);

      return notice;
    },
  ), (failure) => failure));
}
