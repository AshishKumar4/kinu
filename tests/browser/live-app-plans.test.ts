import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../../packages/test-utils/src/scratch';
import { INSPECTOR_SHUT_PX } from '../../scripts/product-flows';
import { PLAN_TASK_TITLES, SLATE_TITLE, SLATE_UI_FILE, SLATE_UI_PAGES } from '../../scripts/scripted-model';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-plans', ['plan-tabs', 'walkthrough', 'kept-tab', 'chat-scroll', 'plan-tasks', 'slate-ui', 'state']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('a long chat pages older history only when the reader scrolls for it', () => {
  test('it opens at its newest message and asks for no older page while the reader sits still', () => {
    const scroll = verdictOf(observed.chatScroll, 'chat-scroll');

    expect(scroll.openFromBottom).toBeLessThan(60);
    expect(scroll.pagesIdleAfterOpen).toBe(0);
  });

  test('a scroll to the top asks for exactly one page', () => {
    expect(verdictOf(observed.chatScroll, 'chat-scroll').pagesOnScrollToTop).toBe(1);
  });

  test('a return to a spot the reopened chat does not hold opens at the newest message, fetching nothing', () => {
    const scroll = verdictOf(observed.chatScroll, 'chat-scroll');

    expect(scroll.pagesIdleAfterReturn).toBe(0);
    expect(scroll.returnFromBottom).toBeLessThan(60);
  });
});

describe('plans have one owner in the inspector column', () => {
  test('no second plan-bearing tab or filter stands beside the first', () => {
    expect(verdictOf(observed.planTabs, 'plan-tabs').planBearing.length).toBeLessThanOrEqual(1);
  });
});

describe('the plan review flow end to end', () => {
  test('a plan comes back for review, with its decision reachable by role', () => {
    const flow = verdictOf(observed.walkthrough, 'walkthrough');

    expect(flow.planReviewShown).toBeTrue();
    expect(flow.approveControl).toMatch(/approve/iu);
  });

  test('the inspector opens on the plan and not before it', () => {
    const flow = verdictOf(observed.walkthrough, 'walkthrough');

    expect(flow.inspectorBeforePlan).toBeLessThanOrEqual(INSPECTOR_SHUT_PX);
    expect(flow.inspectorOnPlan).toBeGreaterThan(INSPECTOR_SHUT_PX);
  });

  test('approving records the decision and enqueues the turn that implements it', () => {
    const flow = verdictOf(observed.walkthrough, 'walkthrough');

    expect(flow.planStatus).toBe('Approved');
    expect(flow.toolCardsAfterImplement).toBeGreaterThan(flow.toolCardsBeforeApproval);
  });

  test("the slate that turn wrote stands in the strip under its own title", () => {
    expect(verdictOf(observed.walkthrough, 'walkthrough').stripLabels).toContain(SLATE_TITLE);
  });
});

describe('the inspector never moves its selection on its own', () => {
  test('a new workspace resolves to Files, and the one change after is the reader\'s click', () => {
    // The row itself ends unless the product read Work filled after the first turn and empty after the second.
    expect(verdictOf(observed.keptTab, 'kept-tab').marks).toEqual(['Files', 'Work']);
  });
});

describe('the live app boots on its own Durable Object state', () => {
  test("the dev server persisted under this run's scratch, never the checkout", () => {
    const state = verdictOf(observed.state, 'state');

    expect(state.root).toStartWith(join(tmpdir(), SCRATCH_ROOT_PREFIX));
    // The plugin's own tree there, not just a directory the harness named:
    // UserDO is the namespace every row's roster and credential goes through.
    expect(state.namespaces).toContain('kinu-UserDO');
  });

  test('nothing but this run stood in that state', () => {
    expect(verdictOf(observed.state, 'state').foreign).toEqual([]);
  });
});

// The approved plan owns the work its turn adds, natively or from a program, a subtask under its step; a chore added
// before any plan existed stays apart from it.
describe('the approved plan owns the tasks its turn adds', () => {
  test('its step, the step\'s subtask and a program\'s step sit under the plan; an earlier chore does not', () => {
    const { plans, unlinked } = verdictOf(observed.planTasks, 'plan-tasks');

    expect(plans).toEqual([[[PLAN_TASK_TITLES.step, 0], [PLAN_TASK_TITLES.sub, 1], [PLAN_TASK_TITLES.programmed, 0]]]);
    expect(unlinked).toEqual([PLAN_TASK_TITLES.chore]);
  });
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
