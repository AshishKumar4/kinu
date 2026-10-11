import { useCallback, useEffect, useRef, useState } from 'react';
import { Effect } from 'effect';
import type { DeferredApproval, ShellApprovalOutcome, ShellApprovalRequest } from '@kinu.run/core';
import { detach } from '@kinu.run/core/obs';
import type { AgentClient } from '../agent-client';
import { askWaitingApprovals, type WaitingApprovalPrompt, type WaitingChoice } from '../waiting-approvals';
import type { ConsentKeyDecision } from './approval-keys';

interface PendingShellApproval {
  request: ShellApprovalRequest;
  resolve(outcome: ShellApprovalOutcome | null): void;
}

/** What the one approval prompt asks: the running turn's own command, or one the workspace's agents parked. */
export type ApprovalPrompt =
  | { readonly kind: 'live'; readonly request: ShellApprovalRequest }
  | { readonly kind: 'waiting'; readonly action: DeferredApproval };

const LIVE_OUTCOME = { once: 'allow', always: 'allow_always', deny: 'deny' } as const satisfies Record<Exclude<ConsentKeyDecision, 'later'>, ShellApprovalOutcome>;

const WAITING_CHOICE = { once: 'approved', always: 'always', deny: 'denied', later: 'later' } as const satisfies Record<ConsentKeyDecision, WaitingChoice>;

/**
 * The terminal's one approval prompt. The running turn's asks come first, each answered on its own; leaving declines
 * them so the backend applies its unattended policy. Between turns, with an empty composer, it asks the workspace's
 * waiting approvals, the queue the web's consent cards decide; `later` leaves them until a turn starts or ends.
 */
export function useApprovals(client: AgentClient, opts: {
  /** A turn is running: waiting approvals are not asked over it. */
  running: boolean;
  /** Nothing else holds the keys and the composer is empty, so no keystroke meant for a draft answers. */
  askable: boolean;
  note: WaitingApprovalPrompt['note'];
}) {
  const queue = useRef<PendingShellApproval[]>([]);
  const [live, setLive] = useState<ShellApprovalRequest | null>(null);

  useEffect(() => {
    const dispose = client.localControls?.setShellApprovalHandler((request) => new Promise((resolve) => {
      queue.current.push({ request, resolve });
      setLive(queue.current[0]?.request ?? null);
    }));

    return () => {
      dispose?.();

      for (const item of queue.current.splice(0)) item.resolve(null);
      setLive(null);
    };
  }, [client]);

  const [waiting, setWaiting] = useState<DeferredApproval | null>(null);
  const answerWaiting = useRef<((choice: WaitingChoice | 'cancelled') => void) | null>(null);
  const pass = useRef<AbortController | null>(null);
  const [putOff, setPutOff] = useState(false);
  const [queueMoves, setQueueMoves] = useState(0);
  const { note } = opts;

  useEffect(() => {
    setPutOff(false);

    return () => {
      pass.current?.abort();
      pass.current = null;
    };
  }, [client, opts.running]);

  useEffect(() => {
    const approvals = client.approvals;

    if (!approvals || opts.running || !opts.askable || putOff || pass.current !== null) return;
    const abort = new AbortController();
    pass.current = abort;

    detach(Effect.promise(async () => {
      const end = await askWaitingApprovals(approvals, {
        present: (action, signal) => {
          const { promise, resolve } = Promise.withResolvers<WaitingChoice | 'cancelled'>();

          const settle = (choice: WaitingChoice | 'cancelled') => {
            answerWaiting.current = null;
            setWaiting(null);
            resolve(choice);
          };

          answerWaiting.current = settle;
          setWaiting(action);
          signal.addEventListener('abort', () => settle('cancelled'), { once: true });

          return promise;
        },
        note,
      }, abort.signal);

      if (pass.current === abort) pass.current = null;

      if (end === 'later' || end === 'failed') setPutOff(true);
    }));
  }, [client, note, opts.running, opts.askable, putOff, queueMoves]);

  const asking: ApprovalPrompt | null = waiting === null ? null : { kind: 'waiting', action: waiting };
  const prompt: ApprovalPrompt | null = live === null ? asking : { kind: 'live', request: live };

  return {
    prompt,
    answer(decision: ConsentKeyDecision) {
      if (live === null) {
        answerWaiting.current?.(WAITING_CHOICE[decision]);

        return;
      }

      if (decision === 'later') return;
      const item = queue.current.shift();
      setLive(queue.current[0]?.request ?? null);
      item?.resolve(LIVE_OUTCOME[decision]);
    },
    /** A frame said the queue moved: a pass reads it again unless one is already asking. */
    queueMoved: useCallback(() => { setQueueMoves((moves) => moves + 1); }, []),
  };
}
