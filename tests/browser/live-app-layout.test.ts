import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../../packages/test-utils/src/scratch';
import { INSPECTOR_SHUT_PX } from '../../scripts/browser-page';
import { RAIL_SHUT_PX, liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-layout', ['controls', 'workspace-views', 'state']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('a collapsed right panel can be reopened and the left rail can be collapsed', () => {
  test("the reader's own control shuts it", () => {
    const controls = verdictOf(observed.controls, 'controls');

    expect(controls.inspectorWidthOpened).toBeGreaterThan(INSPECTOR_SHUT_PX);
    expect(controls.inspectorWidthShut).toBeLessThanOrEqual(INSPECTOR_SHUT_PX);
  });

  test('a control reopens the column the reader collapsed', () => {
    expect(verdictOf(observed.controls, 'controls').inspectorWidthReopened).toBeGreaterThan(INSPECTOR_SHUT_PX);
  });

  test('a control collapses the left rail', () => {
    const lane = verdictOf(observed.controls, 'controls').railLaneAfter;

    expect(lane).toBeGreaterThanOrEqual(0);
    expect(lane).toBeLessThanOrEqual(RAIL_SHUT_PX);
  });
});

// rc29 walkthrough F2: the desktop's own page went with D99, and its address drew the overview in its place.
describe("a workspace's own addresses draw what they name", () => {
  test("the desktop's old address lands on the workspace with its Environment open, never on the overview", () => {
    const views = verdictOf(observed.workspaceViews, 'workspace-views');

    expect(views.desktopOverview).toBe(false);
    expect(views.desktopEnvironment).toBe(true);
    expect(views.desktopLandedAt).toMatch(/^\/workspace\/[^/]+\?environment=desktop$/u);
  });

  test('where the machine Environment chose has a desktop, it is the tab shown', () => {
    expect(verdictOf(observed.workspaceViews, 'workspace-views').desktopTab).not.toBe('other');
  });

  test('a view no page answers says so, and the overview still answers at its own address', () => {
    const views = verdictOf(observed.workspaceViews, 'workspace-views');

    expect(views.unknownOverview).toBe(false);
    expect(views.unknownNotFound).toBe(true);
    expect(views.overviewDrawn).toBe(true);
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
