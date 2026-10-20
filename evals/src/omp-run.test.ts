import { describe, expect, test } from 'bun:test';
import { freezeHeldOut, recordedShell, shellFromRecord } from './omp-run';
import type { OwnerTurn } from './omp';

function asked(id: string, request: string, opts: { followup?: boolean; answer?: string; calls?: OwnerTurn['turn']['toolCalls'] } = {}): OwnerTurn {
  return {
    at: '2026-10-12T00:00:00.000Z',
    followup: opts.followup === false ? null : { text: 'thanks', at: '2026-10-12T00:01:00.000Z' },
    turn: { userMessage: request, assistantResponse: opts.answer ?? 'done', toolCalls: opts.calls ?? [], steps: 1, durationMs: 1, feedback: null, hadError: false, turnId: id, origin: 'user' },
  };
}

const LONG = 'Move the ledger to integer cents and keep every report reading the same totals as before the change.';

describe('the frozen held-out set', () => {
  test('only answered requests that drew a next message and stand alone are drawn, and the set carries its digest', () => {
    const frozen = freezeHeldOut([
      asked('a', LONG), asked('b', 'and the status?'), asked('c', LONG, { followup: false }), asked('d', LONG, { answer: ' ' }), asked('e', `${LONG} Also the exports.`),
    ], { count: 10, seed: 1 });

    expect([...frozen.turnIds].sort()).toEqual(['a', 'e']);
    expect(frozen.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('a kept shell call answered from its record', () => {
  const call = (name: string, argsWindow: string, resultWindow: string) => ({
    name, argsWindow, resultWindow, target: '', op: null, argsDigest: null, writtenPaths: [], revisitedPaths: [],
  });

  test("the same command the turn ran is answered with what it answered; any other is not", () => {
    const answer = shellFromRecord(recordedShell(asked('a', LONG, { calls: [
      call('bash', '{"command":"rg -n cents packages/core"}', 'ledger.ts:12: cents'),
      call('bash', '{"command":"git log -1', 'cut short'),
      call('read', '{"path":"a.ts"}', 'text'),
    ] })));

    expect([
      answer('shell', { command: ' rg -n cents packages/core ' }),
      answer('shell', { command: 'rg -n dollars packages/core' }),
      answer('file', { command: 'rg -n cents packages/core' }),
    ]).toEqual(['ledger.ts:12: cents', null, null]);
  });
});
