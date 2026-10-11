/**
 * The one ask-and-decide pass over a workspace's waiting approvals for every terminal chat: the commands its agents
 * parked on the owner, decided with the same answers the web's consent cards send. Approving runs nothing here; the
 * agent is told and asks again.
 */

import { boundWriteOf, executorLabel, timeAgo, type DeferredApproval, type DeferredApprovalAnswer } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { literalText } from '@kinu.run/core/tui';
import type { WaitingApprovalSurface } from './agent-client';

/** `later` leaves the rest of the queue waiting until the next pass. */
export type WaitingChoice = DeferredApprovalAnswer | 'later';

export interface WaitingApprovalPrompt {
  /** Resolves `cancelled` once `signal` aborts. */
  present(action: DeferredApproval, signal: AbortSignal): Promise<WaitingChoice | 'cancelled'>;
  note(kind: 'decided' | 'error', message: string): void;
}

/** How a pass ended: the queue emptied, the owner put the rest off, the surface took the prompt back, or the queue
 *  could not be read or answered (already noted). */
type WaitingPassEnd = 'empty' | 'later' | 'cancelled' | 'failed';

/** Asks each queued approval, oldest first, once per pass. */
export async function askWaitingApprovals(
  approvals: WaitingApprovalSurface, prompt: WaitingApprovalPrompt, signal: AbortSignal,
): Promise<WaitingPassEnd> {
  const asked = new Set<string>();

  try {
    while (!signal.aborted) {
      const action = (await approvals.list()).find((queued) => queued.status === 'queued' && !asked.has(queued.id));

      if (action === undefined) return 'empty';
      asked.add(action.id);
      const choice = await prompt.present(action, signal);

      if (choice === 'later' || choice === 'cancelled') return choice;
      const { decided } = await approvals.decide([action.id], choice);
      prompt.note('decided', decided.includes(action.id) ? decisionNote(action, choice) : 'It was already decided; nothing changed.');
    }
  } catch (err) {
    prompt.note('error', `Could not reach the approvals waiting on you: ${renderThrownChain({ cause: err })}`);

    return 'failed';
  }

  return 'cancelled';
}

function decisionNote(action: DeferredApproval, choice: DeferredApprovalAnswer): string {
  if (choice === 'denied') return 'Denied. The agent is told.';

  return choice === 'always'
    ? `Always allowed on ${executorLabel(action.executor)} for the rules it tripped. The agent is told.`
    : 'Approved. The agent is told and runs it when it asks again.';
}

/** A file write's exact bytes are its approval; a terminal cannot show them, so only the web approves one. */
export function terminalMayApprove(action: DeferredApproval): boolean {
  return boundWriteOf(action.command) === null;
}

/** What a prompt shows of a waiting approval, the command drawn literally: controls shown, never obeyed. */
export function waitingApprovalDetails(action: DeferredApproval): string {
  const write = boundWriteOf(action.command);
  const what = write === null ? literalText(action.command || '(command)') : `Replace ${literalText(write.path)}`;

  return [what, `Executor: ${executorLabel(action.executor)}`, literalText(action.reason), `Asked ${timeAgo(action.requestedAt)}`]
    .filter(Boolean).join('\n');
}
