/**
 * A workspace's waiting approvals for every terminal chat: the commands its agents parked on the owner, read and
 * answered as the web's consent cards do. Approving runs nothing here; the agent is told and asks again.
 */

import { boundWriteOf, executorLabel, timeAgo, type DeferredApproval, type DeferredApprovalAnswer } from '@kinu.run/core';
import { attempt, renderThrownChain, settle, type KinuError } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { literalText } from '@kinu.run/core/tui';
import type { WaitingApprovalSurface } from './agent-client';

/** `later` leaves what is queued waiting until a turn starts or ends. */
export type WaitingChoice = DeferredApprovalAnswer | 'later';

export interface WaitingApprovalPrompt {
  /** Resolves `cancelled` once `signal` aborts. */
  present(action: DeferredApproval, signal: AbortSignal): Promise<WaitingChoice | 'cancelled'>;
  note(kind: 'decided' | 'error', message: string): void;
}

/** The queued ones, oldest first. */
export function readWaitingApprovals(approvals: WaitingApprovalSurface): Effect.Effect<DeferredApproval[], KinuError> {
  return Effect.map(
    attempt({ doing: 'reading the approvals waiting on you', otherwise: 'unavailable' }, () => approvals.list()),
    (actions) => actions.filter((action) => action.status === 'queued'),
  );
}

/** Sends the answer the web's consent card sends, and says what it did. */
export function answerWaitingApproval(
  approvals: WaitingApprovalSurface, action: DeferredApproval, answer: DeferredApprovalAnswer,
): Effect.Effect<string, KinuError> {
  return Effect.map(
    attempt({ doing: 'answering an approval waiting on you', otherwise: 'unavailable' }, () => approvals.decide([action.id], answer)),
    ({ decided }) => {
      if (!decided.includes(action.id)) return 'It was already decided; nothing changed.';

      if (answer === 'denied') return 'Denied. The agent is told.';

      return answer === 'always'
        ? `Always allowed on ${executorLabel(action.executor)} for the rules it tripped. The agent is told.`
        : 'Approved. The agent is told and runs it when it asks again.';
    },
  );
}

/** Line mode's pass: asks each queued approval once, oldest first, until none is left, `later`, or `signal` aborts. */
export function askWaitingApprovals(
  approvals: WaitingApprovalSurface, prompt: WaitingApprovalPrompt, signal: AbortSignal,
): Promise<void> {
  const pass = Effect.gen(function* () {
    const asked = new Set<string>();

    while (!signal.aborted) {
      const action = (yield* readWaitingApprovals(approvals)).find((queued) => !asked.has(queued.id));

      if (action === undefined || signal.aborted) return;
      asked.add(action.id);
      const choice = yield* Effect.promise(() => prompt.present(action, signal));

      if (choice === 'later' || choice === 'cancelled') return;
      // An answer the owner gave stands, even if a turn started as they gave it.
      prompt.note('decided', yield* answerWaitingApproval(approvals, action, choice));
    }
  });

  return settle(Effect.catch(pass, (failure) => Effect.sync(() => { prompt.note('error', renderThrownChain({ cause: failure })); })));
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
