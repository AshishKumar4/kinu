/**
 * A plan review's decision as one transaction: an editable revision's annotations are persisted before the one
 * `decidePlanReview` that wakes the agent, and nothing edits or decides the plan again while it is in flight. The
 * hook runs under React's client reconciler; its caller renders nothing, so the container is the few fields React reads.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlanDecisionOutcome, PlanReview, Rpc } from '@kinu.run/core';
import { usePlanDecision, type PlanDecision, type PlanDecisionInput } from '../src/hooks/use-plan-decision';

const PLAN: PlanReview = {
  id: 'plan-1', sessionId: 'root', revision: 3, content: '# Plan', status: 'pending', annotations: [], feedback: null,
  handoffAccepted: false, createdAt: 0, updatedAt: 0,
};

const KEYS = ['window', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const saved = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

beforeAll(() => {
  Object.assign(globalThis, { window: { HTMLIFrameElement: class {}, document: { activeElement: null } }, IS_REACT_ACT_ENVIRONMENT: true });
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

/** The hook mounted over `input`, and its current answer. */
async function mounted(input: PlanDecisionInput): Promise<{ readonly current: () => PlanDecision; readonly unmount: () => Promise<void> }> {
  const listens = { addEventListener() {}, removeEventListener() {} };
  const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
  const root = createRoot(container);
  let current: PlanDecision | undefined;

  function Probe(): null {
    current = usePlanDecision(input);

    return null;
  }

  await act(async () => { root.render(createElement(Probe)); });

  return {
    current: () => {
      if (current === undefined) throw new Error('the hook never rendered');

      return current;
    },
    unmount: async () => { await act(async () => { root.unmount(); }); },
  };
}

/** Everything the transaction did, in order: each save, and each rpc with its arguments. */
function recorder(saves: boolean, decided: () => Promise<PlanDecisionOutcome> = async () => ({ ok: true, plan: PLAN, queued: true })) {
  const done: string[] = [];

  // Sent as JSON, as the socket does.
  const rpc: Rpc = async (method, args) => {
    done.push(`${method} ${JSON.stringify(args)}`);

    return JSON.parse(JSON.stringify(method === 'decidePlanReview' ? await decided() : { ok: true, plan: PLAN }));
  };

  const input: PlanDecisionInput = {
    plan: PLAN, editable: true, handoffPending: false, rpc,
    save: async () => {
      done.push('save');

      return saves;
    },
    feedback: () => 'Plan Feedback: tighten step 2',
    onError: (message) => { if (message !== null) done.push(`error ${message}`); },
  };

  return { done, input };
}

describe('a decision on a plan revision', () => {
  test('saves the annotations, then wakes the agent exactly once, carrying them when changes are asked for', async () => {
    const { done, input } = recorder(true);
    const hook = await mounted(input);

    await act(async () => { await hook.current().decide('request_changes'); });

    expect(done).toEqual(['save', 'decidePlanReview ["plan-1",3,"request_changes","Plan Feedback: tighten step 2"]']);
    await hook.unmount();
  });

  test('takes no decision when the annotations were not saved', async () => {
    const { done, input } = recorder(false);
    const hook = await mounted(input);

    await act(async () => { await hook.current().decide('request_changes'); });

    expect(done).toEqual(['save']);
    await hook.unmount();
  });

  test('reports a failed decision and releases the plan for another attempt', async () => {
    let attempts = 0;
    const errors: string[] = [];

    const { input } = recorder(true, async () => {
      attempts += 1;

      if (attempts === 1) throw new Error('review-fixture-rpc-failed');

      return { ok: true, plan: PLAN, queued: true };
    });

    const hook = await mounted({ ...input, onError: (message) => { if (message !== null) errors.push(message); } });

    try {
      await act(async () => { await hook.current().decide('approve'); });

      expect(errors).toEqual([expect.stringContaining('review-fixture-rpc-failed')]);
      expect({ busy: hook.current().busy, inFlight: hook.current().inFlight() }).toEqual({ busy: null, inFlight: false });

      await act(async () => { await hook.current().decide('approve'); });

      expect(attempts).toBe(2);
      expect(errors).toEqual([expect.stringContaining('review-fixture-rpc-failed')]);
    } finally {
      await hook.unmount();
    }
  });

  test('is the only one while it runs: the plan is frozen, and a second decision is dropped', async () => {
    const answer = Promise.withResolvers<PlanDecisionOutcome>();
    const { done, input } = recorder(true, () => answer.promise);
    const hook = await mounted(input);
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();

    await act(async () => { first = hook.current().decide('approve'); });

    expect({ busy: hook.current().busy, inFlight: hook.current().inFlight() }).toEqual({ busy: 'approve', inFlight: true });

    await act(async () => { second = hook.current().decide('approve'); });
    answer.resolve({ ok: true, plan: PLAN, queued: true });
    await act(async () => { await Promise.all([first, second]); });

    expect(done).toEqual(['save', 'decidePlanReview ["plan-1",3,"approve",null]']);
    expect({ busy: hook.current().busy, inFlight: hook.current().inFlight() }).toEqual({ busy: null, inFlight: false });
    await hook.unmount();
  });
});
