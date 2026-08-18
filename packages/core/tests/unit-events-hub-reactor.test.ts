// Reactor decision legality matrix.
import { describe, test, expect } from 'bun:test';
import { isLegalDecision, type ReactorDecision } from '../src/events/hub/index';

const ctxAuth = {
  reactor_head_trust: 'authenticated' as const,
  events_trust_class: 'external' as const,
  current_phase: 'heads' as const,
};

const ctxOwner = {
  reactor_head_trust: 'owner' as const,
  events_trust_class: 'authenticated' as const,
  current_phase: 'heads' as const,
};

const ctxOwnerLowTrustEvents = {
  reactor_head_trust: 'owner' as const,
  events_trust_class: 'external' as const,
  current_phase: 'heads' as const,
};

const ctxMerging = {
  reactor_head_trust: 'owner' as const,
  events_trust_class: 'owner' as const,
  current_phase: 'merging' as const,
};

function dec(headOp: ReactorDecision['head_op'], eventOp: ReactorDecision['event_op']): ReactorDecision {
  return { head_op: headOp, event_op: eventOp, reasoning: 'test' };
}

describe('isLegalDecision — drop requires authenticated + external events', () => {
  test('drop on external by authenticated reactor — legal', () => {
    const r = isLegalDecision(dec({ kind: 'keep' }, { kind: 'drop', reason: 'noise' }), ctxAuth);
    expect(r).toBe(true);
  });
  test('drop on owner-trust events — illegal', () => {
    const r = isLegalDecision(
      dec({ kind: 'keep' }, { kind: 'drop', reason: 'noise' }),
      { ...ctxOwner, events_trust_class: 'owner' },
    );
    expect(r).toBe(false);
  });
  test('drop by external-trust reactor — illegal', () => {
    const r = isLegalDecision(
      dec({ kind: 'keep' }, { kind: 'drop', reason: 'noise' }),
      { ...ctxAuth, reactor_head_trust: 'external' },
    );
    expect(r).toBe(false);
  });
});

describe('isLegalDecision — abort / add require eventOp:handle', () => {
  test('abort_all + handle — legal', () => {
    expect(isLegalDecision(
      dec({ kind: 'abort_all', reason: 'replan' }, { kind: 'handle' }),
      ctxOwner,
    )).toBe(true);
  });
  test('abort_all + defer — illegal', () => {
    expect(isLegalDecision(
      dec({ kind: 'abort_all', reason: 'replan' }, { kind: 'defer', revisit_at: { kind: 'after_phase', phase: 'idle' } }),
      ctxOwner,
    )).toBe(false);
  });
  test('abort_one + drop — illegal', () => {
    expect(isLegalDecision(
      dec({ kind: 'abort_one', head_id: 'h1', reason: 'x' }, { kind: 'drop', reason: 'noise' }),
      ctxOwnerLowTrustEvents,
    )).toBe(false);
  });
  test('add with handle — legal', () => {
    expect(isLegalDecision(
      dec(
        { kind: 'add', spec: { task: 't', rationale: 'r', bound_event_ids: [] } },
        { kind: 'handle' },
      ),
      ctxOwner,
    )).toBe(true);
  });
});

describe('isLegalDecision — add rejected after merging begins', () => {
  test('add during heads — legal', () => {
    expect(isLegalDecision(
      dec({ kind: 'add', spec: { task: 't', rationale: 'r', bound_event_ids: [] } }, { kind: 'handle' }),
      ctxOwner,
    )).toBe(true);
  });
  test('add during merging — illegal', () => {
    expect(isLegalDecision(
      dec({ kind: 'add', spec: { task: 't', rationale: 'r', bound_event_ids: [] } }, { kind: 'handle' }),
      ctxMerging,
    )).toBe(false);
  });
});

describe('isLegalDecision — merge_now permits handle or defer, not drop', () => {
  test('merge_now + handle — legal', () => {
    expect(isLegalDecision(
      dec({ kind: 'merge_now', reason: 'enough' }, { kind: 'handle' }),
      ctxOwner,
    )).toBe(true);
  });
  test('merge_now + defer — legal', () => {
    expect(isLegalDecision(
      dec(
        { kind: 'merge_now', reason: 'enough' },
        { kind: 'defer', revisit_at: { kind: 'after_phase', phase: 'idle' } },
      ),
      ctxOwner,
    )).toBe(true);
  });
  test('merge_now + drop — illegal', () => {
    expect(isLegalDecision(
      dec({ kind: 'merge_now', reason: 'enough' }, { kind: 'drop', reason: 'noise' }),
      ctxOwnerLowTrustEvents,
    )).toBe(false);
  });
});
