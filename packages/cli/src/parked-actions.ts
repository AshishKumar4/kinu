import { type DeferredApproval, type DeferredApprovalAnswer } from '@kinu.run/core';
import { literalText } from '@kinu.run/core/tui';
import { attempt, settle, toWire, type KinuError, type Wire } from '@kinu.run/core/obs';
import type { LocalSessionControls } from './agent-client';

export const PARKED_USAGE = '/parked [approve|deny <id...|all> | always <id...>]';

export function parkedAnswer(verb: string | undefined): DeferredApprovalAnswer | null {
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
    'Each waits until you decide it: none runs or expires on its own.',
    `Decide with ${PARKED_USAGE}. \`always\` also stops asking about the same rules on that machine.`,
  ].join('\n');
}

export const ALWAYS_NAMES_EACH = '`always` grants standing approval, so name each command it is for: /parked always <id...>.';

export function renderParkedDecision(
  decision: { readonly answer: DeferredApprovalAnswer; readonly ids: readonly string[] },
  decided: readonly string[], parked: readonly DeferredApproval[],
): string {
  const lines = decision.answer === 'always'
    ? parked.filter((action) => decided.includes(action.id)).map((action) =>
      `Approved ${action.id}. From now on ${action.executor} runs commands that trip the same rules without asking: `
        + literalText(action.reason))
    : [`${decision.answer === 'denied' ? 'Denied' : 'Approved'}: ${decided.length === 0 ? 'none' : decided.join(', ')}.`];

  const missed = decision.ids.filter((id) => !decided.includes(id));

  if (decision.answer === 'always' && decided.length === 0) lines.push('Approved: none.');

  if (missed.length > 0) lines.push(`Not waiting, so nothing to decide: ${missed.join(', ')}.`);

  return lines.join('\n');
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
