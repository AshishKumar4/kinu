// Backend conformance — the cf composition roots, observed for real.
//
// Each observation below comes from the PRODUCTION composition path on a real
// actor instance (tests/helpers/actor-harness.ts): the ToolSet is whatever
// `getRawTools()` built, the action enums are read from the input schemas the
// model would receive, and the tables are `sqlite_master` after the real
// `ensureSchema()` ran. The manifest in core declares what each root wires
// and why the rest is deliberately absent; `compareSurface` fails on any
// disagreement in either direction. See core/src/conformance/manifest.ts.
import { describe, test, expect } from 'bun:test';
import {
  compareSurface, normalizeObservedTables, observedActionEnum,
  renderConformanceFindings,
  type ConformanceRoot, type ObservedSurface,
} from '@proteus/core';
import { orchestratorHarness, subordinateHarness, type ActorHarness } from './helpers/actor-harness.js';

function observe(root: ConformanceRoot, harness: ActorHarness<unknown>): ObservedSurface {
  const tools = (harness.agent as { getRawTools(): Record<string, unknown> }).getRawTools();
  return {
    root,
    planes: {
      tool: new Set(Object.keys(tools)),
      'agents-action': observedActionEnum(tools.agents),
      'memory-action': observedActionEnum(tools.memory),
      table: normalizeObservedTables(harness.tableNames()),
    },
  };
}

describe('cf backend conformance', () => {
  for (const [root, make] of [
    ['cf-orchestrator', orchestratorHarness],
    ['cf-subordinate', subordinateHarness],
  ] as const) {
    test(`${root}: the observed surface matches the manifest`, () => {
      const report = compareSurface(observe(root, make()));
      expect(renderConformanceFindings(report)).toBe('');
      expect(report.unmeasured).toEqual([]);
    });
  }

  test('the observation sees a real surface at all (guards the guard)', () => {
    // If getRawTools were stubbed away or the harness drifted to a fake, the
    // conformance tests above would compare an empty world and pass whatever
    // the manifest says about nothing.
    const observed = observe('cf-orchestrator', orchestratorHarness());
    expect(observed.planes.tool!.size).toBeGreaterThanOrEqual(6);
    expect(observed.planes.table!.size).toBeGreaterThanOrEqual(30);
    expect(observed.planes.tool!.has('execute_tools')).toBe(true);
  });
});
