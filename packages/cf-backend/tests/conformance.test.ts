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
import type { ToolSet } from 'ai';
import {
  compareSurface, normalizeObservedTables, observedActionEnum,
  renderConformanceFindings,
  type ConformanceRoot, type ObservedSurface,
} from '@proteus/core';
import { orchestratorHarness, subordinateHarness, type ActorHarness } from './helpers/actor-harness.js';

interface RawToolsAgent { observeRawTools(): ToolSet }

function observe(root: ConformanceRoot, harness: ActorHarness<RawToolsAgent>): ObservedSurface {
  const tools = harness.agent.observeRawTools();
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
  const ROOTS = [
    ['cf-orchestrator', orchestratorHarness],
    ['cf-subordinate', subordinateHarness],
  ] as const;

  for (const [root, make] of ROOTS) {
    test(`${root}: the observed surface matches the manifest`, () => {
      const report = compareSurface(observe(root, make()));
      expect(renderConformanceFindings(report)).toBe('');
      expect(report.unmeasured).toEqual([]);
    });

    // Guards the guard, once per root rather than once in total. The floor used
    // to be asserted for the orchestrator alone, so the SUBORDINATE's
    // magnitudes were unverified: a harness that drifted to a thin fake there
    // would still fail on capabilities the manifest declares `wired`, but
    // everything it declares `absent` would look conformant against a world
    // that was never built. Same list as above, so a third root added later is
    // covered without a second place to remember.
    test(`${root}: the observation sees a real surface at all`, () => {
      const observed = observe(root, make());
      expect(observed.planes.tool!.size).toBeGreaterThanOrEqual(6);
      expect(observed.planes.table!.size).toBeGreaterThanOrEqual(30);
      expect(observed.planes.tool!.has('execute_tools')).toBe(true);
    });
  }
});
