// buildStrategyForkDeps — the fork substrate's per-call defaultOptions, and
// specifically the onPhase FACTORY.
//
// The regression this pins: a fork on the interactive surface now detaches
// the instant it spawns (defect A — see jobs/threshold.ts withSpawnDetach).
// Both backends' onPhase used to be a single static function reading their
// OWN "current run id" field live, at the moment each phase fired. Once a
// fork detaches immediately, its 'head_split' phase can fire after the
// calling turn's run has already closed, and 'head_merge' — which only
// fires once the WHOLE exploration finishes — ALWAYS fires after. A live
// read then either drops the event (CLI, which nulls its pointer on close)
// or misattributes it to whatever unrelated turn is running by the time
// merge finally happens (cf, whose pointer is never nulled between turns) —
// either way the fork's cost and result vanish from the durable ledger for
// every fork that detaches, not just slow ones.
//
// The fix: `ForkDepsWiring.heads.onPhase` is a FACTORY, invoked once per
// fork call by `defaultOptions()` — at DISPATCH time, before any detach
// decision, while the backend's run-scope is still guaranteed live. The
// backend captures it there and returns a closure bound to that captured
// value, so every phase of ONE fork call lands on the SAME run regardless
// of how long the exploration takes or what runs after it.
import { describe, test, expect } from 'bun:test';
import { buildStrategyForkDeps, type ForkDepsWiring } from '../src/orchestrator/fork-deps.js';
import type { SplitPhaseEvent } from '../src/heads/controller.js';
import { createTestRuntime } from './helpers.js';

function wiring(overrides: Partial<ForkDepsWiring['heads']> = {}): {
  wiring: ForkDepsWiring;
  onPhaseFactoryCalls: number;
} {
  const { rt } = createTestRuntime();
  let onPhaseFactoryCalls = 0;
  const heads: ForkDepsWiring['heads'] = {
    controller: () => ({}) as never,
    inheritedContext: () => [],
    onPhase: () => { onPhaseFactoryCalls++; return () => {}; },
    onComplete: () => {},
    ...overrides,
  };
  return {
    wiring: {
      rt,
      model: rt.llm as never,
      mcts: { session: () => ({}) as never, search: {} as never, overrides: () => ({}) },
      heads,
    },
    onPhaseFactoryCalls: 0,
  };
}

describe('buildStrategyForkDeps — the onPhase factory is resolved once per fork call, at dispatch', () => {
  test('defaultOptions() invokes the onPhase factory exactly once per call — not once per phase', () => {
    let calls = 0;
    const { wiring: w } = wiring({ onPhase: () => { calls++; return () => {}; } });
    const deps = buildStrategyForkDeps(w);

    const options1 = deps.defaultOptions!() as { heads: { onPhase: (e: SplitPhaseEvent) => void } };
    expect(calls).toBe(1);
    // The SAME resolved closure fires for both 'split' and 'merge' — the
    // factory is not re-invoked per phase.
    options1.heads.onPhase({ kind: 'split', rootId: 'r1', headIds: ['h1', 'h2'], rationale: 'x' });
    options1.heads.onPhase({
      kind: 'merge', rootId: 'r1', mergedNarrative: 'done',
      cost: { headCount: 2, headsWithFindings: 2, totalTokens: 10, totalWallClockMs: 500, maxDepth: 1 },
      fileChanges: [], blindSpots: [],
    });
    expect(calls).toBe(1);
  });

  test('a value captured by the factory at dispatch survives a later change to the live source — the closure does not re-read', () => {
    // Simulates a backend whose "current run" pointer moves on (or is
    // nulled) between a fork's split and merge phases — exactly what
    // happens once a fork detaches on spawn instead of finishing inline.
    let live: string | null = 'run-A';
    const seen: Array<{ phase: string; runId: string | null }> = [];
    const { wiring: w } = wiring({
      onPhase: () => {
        const capturedAtDispatch = live; // captured NOW, at defaultOptions() time
        return (event: SplitPhaseEvent) => seen.push({ phase: event.kind, runId: capturedAtDispatch });
      },
    });
    const deps = buildStrategyForkDeps(w);
    const options = deps.defaultOptions!() as { heads: { onPhase: (e: SplitPhaseEvent) => void } };

    // 'split' fires while the run is still live.
    options.heads.onPhase({ kind: 'split', rootId: 'r1', headIds: ['h1', 'h2'], rationale: 'x' });

    // The calling turn closes its run — the live pointer moves on, exactly
    // like local-session's currentRunId going null or cf's _currentRunId
    // rolling to the next turn.
    live = null;

    // 'merge' fires long after — but the ALREADY-RESOLVED closure still
    // reports the run id that was live at DISPATCH, not the (now different)
    // live value.
    options.heads.onPhase({
      kind: 'merge', rootId: 'r1', mergedNarrative: 'done',
      cost: { headCount: 2, headsWithFindings: 2, totalTokens: 10, totalWallClockMs: 500, maxDepth: 1 },
      fileChanges: [], blindSpots: [],
    });

    expect(seen).toEqual([
      { phase: 'split', runId: 'run-A' },
      { phase: 'merge', runId: 'run-A' },
    ]);
  });

  test('two separate fork calls each capture their OWN dispatch-time value — no leakage between forks', () => {
    let live = 'run-A';
    const seen: Array<{ call: number; runId: string }> = [];
    let callIndex = 0;
    const { wiring: w } = wiring({
      onPhase: () => {
        const call = ++callIndex;
        const capturedAtDispatch = live;
        return (event: SplitPhaseEvent) => {
          if (event.kind === 'split') seen.push({ call, runId: capturedAtDispatch });
        };
      },
    });
    const deps = buildStrategyForkDeps(w);

    const first = deps.defaultOptions!() as { heads: { onPhase: (e: SplitPhaseEvent) => void } };
    first.heads.onPhase({ kind: 'split', rootId: 'r1', headIds: ['h1'], rationale: 'first fork' });

    live = 'run-B'; // a second, later fork call dispatches under a different run
    const second = deps.defaultOptions!() as { heads: { onPhase: (e: SplitPhaseEvent) => void } };
    second.heads.onPhase({ kind: 'split', rootId: 'r2', headIds: ['h1'], rationale: 'second fork' });

    expect(seen).toEqual([
      { call: 1, runId: 'run-A' },
      { call: 2, runId: 'run-B' },
    ]);
  });
});
