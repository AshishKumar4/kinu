/**
 * Defends #67: an empty live list (`Think.messages`) over a full store never
 * started the history walk.
 */
import { describe, expect, test } from 'bun:test';
import { walkStart } from '../src/hooks/use-paged-scroll';

describe('starting the walk', () => {
  test('a live list with messages walks back from its oldest one', () => {
    expect(walkStart('m1', true)).toEqual({ after: 'm1' });
  });

  test('nothing delivered yet is "ask again", never "there is nothing"', () => {
    // Before the connect frame, reading the store would race the seed.
    expect(walkStart(undefined, false)).toBeNull();
  });

  test('a DELIVERED empty list reads the newest page instead of concluding', () => {
    expect(walkStart(undefined, true)).toBe('newest');
  });

  test('an anchor wins over delivery, so a seeded list never re-reads its own tail', () => {
    expect(walkStart('m1', false)).toEqual({ after: 'm1' });
  });
});
