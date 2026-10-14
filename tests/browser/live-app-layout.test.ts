import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../../packages/test-utils/src/scratch';
import { INSPECTOR_SHUT_PX } from '../../scripts/browser-page';
import { RAIL_SHUT_PX, liveRows } from '../../scripts/live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-layout', ['controls', 'state']);

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
