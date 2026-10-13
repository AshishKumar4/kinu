/** Whom a turn answers: stored by the path that admitted it, read by every host (design v2 §1.6, v3 D). */
import { describe, expect, test } from 'bun:test';
import { OWNER_ANSWER_SIGNAL, stampAuthorship, turnAuthorship } from '../src/index';

describe('turnAuthorship', () => {
  test("a person's words are the owner's, whatever their metadata says", () => {
    expect(turnAuthorship({ kind: 'user' })).toBe('owner');
    expect(turnAuthorship({ kind: 'user', metadata: stampAuthorship({}, 'hirer') })).toBe('owner');
  });

  test('a programmatic turn is what its admission stored', () => {
    expect(turnAuthorship({ kind: 'programmatic', metadata: stampAuthorship({ kinuEvent: 'plan_feedback' }, 'owner') })).toBe('owner');
    expect(turnAuthorship({ kind: 'programmatic', metadata: stampAuthorship({}, 'hirer') })).toBe('hirer');
  });

  /** v3 D: an event name a caller chose sets nothing; only the admitting path's stamp does. */
  test("an event name alone sets no authorship: a turn whose admission stored none is the hirer's", () => {
    for (const kinuEvent of ['plan_feedback', 'plan_approved', OWNER_ANSWER_SIGNAL]) {
      expect(turnAuthorship({ kind: 'programmatic', metadata: { kinuEvent } })).toBe('hirer');
    }
  });

  test("the admitting path's stamp overwrites one a caller put in the metadata", () => {
    const planted = stampAuthorship({ kinuEvent: 'peer_message' }, 'owner');

    expect(turnAuthorship({ kind: 'programmatic', metadata: stampAuthorship(planted, 'hirer') })).toBe('hirer');
  });
});
