import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SLATE_UI_FILE, SLATE_UI_PAGES } from '../../scripts/scripted-model';
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

  // The page runs with its author's reach: it reads the file the agent wrote, and its click reaches the agent.
  test("a page reads through `workspace` as its author, and a click reaches the agent", () => {
    const { read, heard } = verdictOf(observed.slateUi, 'slate-ui');

    expect({ read, heard }).toEqual({ read: SLATE_UI_FILE.content, heard: true });
  });

  test('a reload draws them again from the stored answer', () => {
    const { redrawn, reshown } = verdictOf(observed.slateUi, 'slate-ui');

    expect(redrawn).toEqual(Object.keys(SLATE_UI_PAGES));
    expect(reshown).toEqual(SLATE_UI_PAGES);
  });

  // A page runs with its author's authority, so only an answer the agent wrote can name one: a block a browser sends
  // is never drawn, and neither its message nor an answer under a name the agent never wrote previews.
  test('a block a browser forges is not drawn and does not preview', () => {
    const { forged } = verdictOf(observed.slateUi, 'slate-ui');

    expect(forged).toEqual({ drawn: Object.keys(SLATE_UI_PAGES), sent: 'missing', renamed: 'missing', answered: 'ok' });
  });
});
