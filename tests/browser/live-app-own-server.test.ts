import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../../packages/test-utils/src/scratch';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-own-server', ['own-server', 'state']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

// The walkthrough's implement turn writes a slate whose class's own `fetch` answers its page. The answer that wrote it
// draws it, and the runner opens that page as it opens its own: at the page's height, in the chat's theme.
describe('a slate that serves its own page is drawn in the answer that wrote it', () => {
  test('it is as tall as its page and reads in the chat\'s theme, dark and light alike', () => {
    const ownServer = verdictOf(observed.ownServer, 'own-server');

    for (const [scheme, reading] of Object.entries(ownServer)) {
      expect({ scheme, scrolls: reading.scrolls }).toEqual({ scheme, scrolls: false });
      // Within the rounding of a height said in whole pixels.
      expect({ scheme, atContent: Math.abs(reading.frame - reading.page) <= 2 }).toEqual({ scheme, atContent: true });
      expect({ scheme, text: reading.pageText }).toEqual({ scheme, text: reading.chatText });
    }

    // Two schemes, two palettes: a page that ignored the host would read the same in both.
    expect(ownServer.dark.pageText).not.toBe(ownServer.light.pageText);
  });
});

describe('the live app boots on its own Durable Object state', () => {
  test("the dev server persisted under this run's scratch, never the checkout", () => {
    const state = verdictOf(observed.state, 'state');

    expect(state.root).toStartWith(join(tmpdir(), SCRATCH_ROOT_PREFIX));
    expect(state.namespaces).toContain('kinu-UserDO');
  });

  test('nothing but this run stood in that state', () => {
    expect(verdictOf(observed.state, 'state').foreign).toEqual([]);
  });
});
