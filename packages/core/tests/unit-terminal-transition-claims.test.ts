/**
 * The terminal transition's claim over real SQLite: an interrupted sequence stays legible as
 * unfinished, a re-entry says so, an unidentified turn is never given an invented key, and a
 * sequence a live process holds wakes past the busy window rather than on its overdue instant.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createTestActors } from '@kinu.run/test-utils';
import { TerminalTransitions, TERMINAL_TRANSITION_CALL_ID } from '../src/orchestrator/terminal-transition';
import {
  initTerminalEffectTable, terminalEffect, TerminalEffectInterrupt, TERMINAL_EFFECT_RETRY_CEILING_MS,
} from '../src/orchestrator/terminal-effects';
import { initToolEffectClaimTable } from '../src/tools/effect-claim';
import { makeExecRaw, makeSql } from './helpers';

const NOW = 1_700_000_000_000;

function ledger(opts: { readonly cutBeforeRecord?: boolean } = {}) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const actor = createTestActors(sql, execRaw).main;
  initTerminalEffectTable(execRaw);
  initToolEffectClaimTable(execRaw);

  const transitions = new TerminalTransitions({
    sql, actor, now: () => NOW,
    effects: { turn_record: terminalEffect({ input: v.object({}), run: () => ({ status: 'completed' }) }) },
    fault: () => opts.cutBeforeRecord === true
      ? (phase, name, scope) => { if (phase === 'before') throw new TerminalEffectInterrupt(phase, name, scope); }
      : null,
    scheduleRetry: async () => { await Promise.resolve(); },
    transaction: <T>(body: () => T): T => db.transaction(body)(),
  });

  const claims = () => sql<{ turn_id: string; call_id: string; result_json: string | null }>`
    SELECT turn_id, normalized_call_id AS call_id, result_json FROM tool_effect_claims
    WHERE normalized_call_id LIKE ${`${TERMINAL_TRANSITION_CALL_ID}:%`} ORDER BY turn_id`;

  return { transitions, claims };
}

describe('the terminal transition claim', () => {
  /** An isolate reset between the claim and the first effect must leave a row with no result. */
  test('a claimed sequence that never finishes stays legible as unfinished', () => {
    const { transitions, claims } = ledger();

    expect(transitions.begin({ turnId: 'u-cut', messageId: 'a-1' })).toBe('first');
    expect(claims()).toEqual([{ turn_id: 'u-cut', call_id: 'terminal:response:a-1', result_json: null }]);
  });

  test('re-entering an unfinished sequence says so, and a closed one reads as done', () => {
    const { transitions } = ledger();
    const transition = { turnId: 'u-again', messageId: 'a-1' };

    expect(transitions.begin(transition)).toBe('first');
    expect(transitions.begin(transition)).toBe('resumed');
    transitions.end(transition);
    expect(transitions.begin(transition)).toBe('done');
  });

  /** Invented identities would collide: every unclaimable turn would share one key. */
  test('a turn with no durable identity is unclaimed rather than invented', () => {
    const { transitions, claims } = ledger();

    expect(transitions.begin(null)).toBe('unclaimed');
    expect(claims()).toEqual([]);
  });

  /**
   * A sequence the live process runs is deferred, not woken on its overdue instant (which re-arms
   * every second) nor excluded (a fired one-shot wake leaves no carrier).
   */
  test('a live sequence keeps a wake, pushed past the busy window', async () => {
    const { transitions } = ledger({ cutBeforeRecord: true });
    const transition = { turnId: 'u-live-wake', messageId: 'a-live-wake' };

    await expect(transitions.settle({
      transition,
      declare: () => [{ name: 'turn_record', scope: 'a-live-wake', input: {}, lane: 'inline' }],
      hold: () => {},
    })).rejects.toThrow('interrupted before its side effect');

    const owedAt = transitions.ledger.nextRetryAt(new Set());
    const deferredAt = transitions.ledger.nextRetryAt(new Set([transitions.sequenceId(transition)]));

    if (owedAt === null || deferredAt === null) throw new Error('the owed row armed no retry instant');
    // Not dropped, and not the overdue instant that would re-arm on every tick.
    expect(deferredAt).toBeGreaterThan(owedAt);
    expect(deferredAt).toBeGreaterThanOrEqual(NOW + TERMINAL_EFFECT_RETRY_CEILING_MS - 1_000);
  });
});
