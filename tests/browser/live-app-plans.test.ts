import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../../packages/test-utils/src/scratch';
import { INSPECTOR_SHUT_PX } from '../../scripts/product-flows';
import { SLATE_TITLE } from '../../scripts/scripted-model';
import { liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-plans', ['plan-tabs', 'walkthrough', 'kept-tab', 'chat-scroll', 'state']);

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
