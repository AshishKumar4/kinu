import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SLATE_UI_PAGES } from '../../scripts/scripted-model';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-slates', ['slate-ui']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

// An agent writes a page into its answer as a <slate-ui> block. The chat draws each block in place as a slate of its
// own, whose page is read from the stored answer, so a reload draws the same pages again.
describe("an answer's slate-ui blocks are drawn in place", () => {
  test('two blocks are two slates, each showing its own page', () => {
    const { drawn, shown } = verdictOf(observed.slateUi, 'slate-ui');

    expect(drawn).toEqual(Object.keys(SLATE_UI_PAGES));
    expect(shown).toEqual(SLATE_UI_PAGES);
  });

  test('a reload draws them again from the stored answer', () => {
    const { redrawn, reshown } = verdictOf(observed.slateUi, 'slate-ui');

    expect(redrawn).toEqual(Object.keys(SLATE_UI_PAGES));
    expect(reshown).toEqual(SLATE_UI_PAGES);
  });
});
