/**
 * Where the chat's walk back through storage begins.
 *
 * The report (#67, images/067_1): a workspace opened with no prior messages at
 * all. The live list a chat is seeded with is `Think.messages`, a window over
 * storage rebuilt on every activation — so it can be empty while the store
 * holds the whole conversation. The walk that reaches older history was
 * anchored on the oldest LIVE message, and with no live messages it had no
 * anchor, so it never issued a request. An empty pane, a full store, and
 * nothing asking.
 *
 * The two are different states and the answer has to distinguish them.
 */
import { describe, expect, test } from 'bun:test';
import { walkStart } from '../src/hooks/use-paged-scroll';

describe('starting the walk', () => {
  test('a live list with messages walks back from its oldest one', () => {
    expect(walkStart('m1', true)).toEqual({ after: 'm1' });
  });

  test('nothing delivered yet is "ask again", never "there is nothing"', () => {
    // The connect frame has not arrived. Reading the store now would race the
    // seed and prepend a page the socket is about to deliver anyway.
    expect(walkStart(undefined, false)).toBeNull();
  });

  test('a DELIVERED empty list reads the newest page instead of concluding', () => {
    // The fix. The server has stated the live list and it is empty; the store
    // is the only thing that can say whether the conversation is empty too.
    expect(walkStart(undefined, true)).toBe('newest');
  });

  test('an anchor wins over delivery, so a seeded list never re-reads its own tail', () => {
    expect(walkStart('m1', false)).toEqual({ after: 'm1' });
  });
});
