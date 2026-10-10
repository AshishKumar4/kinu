/** Whom a turn answers, the one rule every host reads (design v2 §1.6). */
import { describe, expect, test } from 'bun:test';
import { OWNER_ANSWER_SIGNAL, turnAuthorship } from '../src/index';

describe('turnAuthorship', () => {
  test("the owner's words and the owner's decisions are the owner's", () => {
    expect(turnAuthorship({ kind: 'user' })).toBe('owner');
    expect(turnAuthorship({ kind: 'user', event: 'peer_message' })).toBe('owner');

    for (const event of ['plan_feedback', 'plan_approved', OWNER_ANSWER_SIGNAL]) expect(turnAuthorship({ kind: 'programmatic', event })).toBe('owner');
  });

  test('every other programmatic turn is its hirer\'s', () => {
    expect(turnAuthorship({ kind: 'programmatic' })).toBe('hirer');
    expect(turnAuthorship({ kind: 'programmatic', event: 'peer_message' })).toBe('hirer');
  });
});
