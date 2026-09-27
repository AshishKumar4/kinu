import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_ROOT_PREFIX } from '../packages/test-utils/src/scratch';
import { INSPECTOR_SHUT_PX } from './product-flows';
import { RAIL_SHUT_PX, liveRows } from './live-app-rows';

const { observed, verdictOf, boot } = liveRows('live-app-layout', ['panel', 'geometry', 'controls', 'state']);

beforeAll(boot);

afterAll(() => {
  if (observed.bootFailure !== null) throw new Error(observed.bootFailure);
});

describe('the right panel keeps its Work, Files and Env state when the chat tab changes', () => {
  test('the Files surface DOM node identity and scroll position survive', () => {
    const panel = verdictOf(observed.panel, 'panel');

    expect(panel.nodeSurvives).toBe(true);
    expect(panel.scrollSurvives).toBe(true);
  });

  test('no refetch of the workspace-scoped reads occurs on either switch', () => {
    const panel = verdictOf(observed.panel, 'panel');

    expect(panel.workspaceReadsOnSwitch).toBe(0);
    expect(panel.workspaceReadsOnBack).toBe(0);
  });

  test("the '+' tab's own actor socket answered its pane", () => {
    expect(verdictOf(observed.panel, 'panel').agentSocketFrames).toBeGreaterThan(0);
  });
});

describe("the tab strip's rule is continuous and the active underline sits on it", () => {
  test('dark: one rule, reaching the column edge, the underline on it', () => {
    const dark = verdictOf(observed.geometry, 'geometry').dark;

    expect(dark.mode).toBe('dark');
    expect(dark.ruleBottom).toBe(dark.stripBottom);
    expect(Math.abs(dark.ruleRight - dark.panelRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(dark.activeBottom - dark.ruleBottom)).toBeLessThanOrEqual(1);
  });

  test('light: one rule, reaching the column edge, the underline on it', () => {
    const light = verdictOf(observed.geometry, 'geometry').light;

    expect(light.mode).toBe('light');
    expect(light.ruleBottom).toBe(light.stripBottom);
    expect(Math.abs(light.ruleRight - light.panelRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(light.activeBottom - light.ruleBottom)).toBeLessThanOrEqual(1);
  });

  test('the chat and inspector rules are one line across the two columns', () => {
    const geometry = verdictOf(observed.geometry, 'geometry');

    expect(Math.abs(geometry.dark.chatRuleBottom - geometry.dark.ruleBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.light.chatRuleBottom - geometry.light.ruleBottom)).toBeLessThanOrEqual(1);
  });
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
