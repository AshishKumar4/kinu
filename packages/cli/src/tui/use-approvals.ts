import { useCallback, useEffect, useRef, useState } from 'react';
import { Effect } from 'effect';
import type { DeferredApproval, DeferredApprovalAnswer, ShellApprovalOutcome, ShellApprovalRequest } from '@kinu.run/core';
import { detach, renderThrownChain } from '@kinu.run/core/obs';
import type { AgentClient } from '../agent-client';
import { answerWaitingApproval, readWaitingApprovals, type WaitingApprovalPrompt, type WaitingChoice } from '../waiting-approvals';
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
 * them so the backend applies its unattended policy. Between turns, with an empty composer and nothing else open, it
 * asks the workspace's waiting approvals, the queue the web's consent cards decide; `later` leaves what is queued
 * until a turn starts or ends. What it shows is what each render read, so a key answers only the prompt drawn.
 */
export function useApprovals(client: AgentClient, opts: {
  /** A turn is running: waiting approvals are not asked over it. */
  running: boolean;
  /** The chat has connected; before that there is nothing to ask through. */
  ready: boolean;
  /** Waiting approvals wait for an empty composer, so no keystroke meant for a draft answers one. */
  draft: string;
  /** Another prompt or panel holds the keys. */
  othersOpen: boolean;
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

  const { note } = opts;
  /** The last read, kept with the client it was read from so a switch never shows another workspace's. */
  const [waiting, setWaiting] = useState<{ readonly client: AgentClient; readonly actions: readonly DeferredApproval[] } | null>(null);
  /** `later` holds every waiting approval back until a turn starts or ends. */
  const [putOff, setPutOff] = useState(false);
  /** The answer on its way, kept with the client it is for. */
  const [chosen, setChosen] = useState<{ readonly client: AgentClient; readonly action: DeferredApproval; readonly answer: DeferredApprovalAnswer } | null>(null);
  /** The drawn prompt a key already answered: set before the render that hides it, so a second key answers nothing. */
  const handled = useRef<DeferredApproval | null>(null);
  const sent = useRef<typeof chosen>(null);
  /** Bumped as each answer completes: a read begun before it may still hold the answered row, so it is dropped. */
  const answered = useRef(0);
  /** Bumped when a frame says the queue moved and after each answer, so the queue is read again. */
  const [moves, setMoves] = useState(0);

  // A turn's start or end ends `later`, and what was read before it is stale until read again.
  useEffect(() => {
    handled.current = null;
    setPutOff(false);
    setWaiting(null);
  }, [client, opts.running]);

  useEffect(() => {
    const approvals = client.approvals;

    if (!approvals || !opts.ready || opts.running) return;
    let current = true;
    const since = answered.current;

    detach(Effect.match(readWaitingApprovals(approvals), {
      onSuccess: (actions) => { if (current && since === answered.current) setWaiting({ client, actions }); },
      onFailure: (failure) => { if (current) note('error', renderThrownChain({ cause: failure })); },
    }));

    return () => { current = false; };
  }, [client, note, opts.ready, opts.running, moves]);

  useEffect(() => {
    const approvals = chosen?.client.approvals;

    if (chosen === null || !approvals || sent.current === chosen) return;
    sent.current = chosen;

    detach(Effect.ensuring(Effect.match(answerWaitingApproval(approvals, chosen.action, chosen.answer), {
      onSuccess: (said) => { note('decided', said); },
      onFailure: (failure) => { note('error', renderThrownChain({ cause: failure })); },
    }), Effect.sync(() => {
      // Answered or refused, the row leaves; only a read begun after this draws it again, as a prompt no key has answered.
      answered.current += 1;
      handled.current = null;
      setWaiting((read) => (read?.client === chosen.client
        ? { client: read.client, actions: read.actions.filter((queued) => queued.id !== chosen.action.id) }
        : read));
      setChosen(null);
      setMoves((count) => count + 1);
    })));
  }, [chosen, note]);

  const askable = opts.ready && !opts.running && opts.draft === '' && !opts.othersOpen && !putOff && chosen === null && waiting?.client === client;
  const action = askable ? waiting.actions[0] : undefined;
  const asking: ApprovalPrompt | null = action === undefined ? null : { kind: 'waiting', action };
  const prompt: ApprovalPrompt | null = live === null ? asking : { kind: 'live', request: live };

  return {
    prompt,
    answer(decision: ConsentKeyDecision) {
      if (prompt?.kind === 'waiting') {
        const choice = WAITING_CHOICE[decision];

        if (handled.current === prompt.action) return;
        handled.current = prompt.action;

        if (choice === 'later') setPutOff(true);
        else setChosen({ client, action: prompt.action, answer: choice });

        return;
      }

      if (prompt === null || decision === 'later') return;
      const item = queue.current.shift();
      setLive(queue.current[0]?.request ?? null);
      item?.resolve(LIVE_OUTCOME[decision]);
    },
    /** A frame said the queue moved. */
    queueMoved: useCallback(() => { setMoves((count) => count + 1); }, []),
  };
}
