// wrapToolsForBackground — the two shapes of backgroundable work, one wrapper.
//
// Defect A (see bench artifact PROGRAM-LEDGER context): a fork sat 30s in the
// interactive chat doing nothing visible before the OLD wrapper detached it,
// because every backgroundable tool rode the SAME timed threshold regardless
// of whether its duration was genuinely unknown (`run`, `execute_tools`) or
// long by construction (`agents` fork). This file pins the fix at the wiring
// layer: `agents` fork is 'spawn'-shaped and detaches the moment its spawn is
// confirmed — but ONLY on a surface whose session outlives the turn to
// receive the wake (policy.detachSpawnOnStart); `run`/`execute_tools` stay
// 'result'-shaped and always ride the timed race, on every surface.
import { describe, test, expect } from 'bun:test';
import type { ToolSet } from 'ai';
import {
  wrapToolsForBackground, BACKGROUNDABLE_TOOLS,
} from '../src/orchestrator/background-tools.js';
import { readSpawnStarted, BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome } from '../src/jobs/index.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal BackgroundJobRunner double — only the two members the wrapper
 *  reads (`thresholdDeps`, `policy`), over a caller-supplied onThreshold so
 *  each test observes exactly when the wrapper crossed. */
function fakeJobRunner(policy: BackgroundPolicy, onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome) {
  return {
    policy,
    thresholdDeps: (kind: string) => ({ thresholdMs: policy.detachAfterMs, onThreshold }),
  };
}

/** A fork tool shaped like the real `agents` tool's execute: it announces its
 *  spawn (readSpawnStarted) right after "validating" input, then the
 *  exploration itself runs long. Mirrors agents-tool.ts's own call to
 *  readSpawnStarted(toolOptions)?.() before strat.explore(). */
function fakeForkTool(exploreMs: number): ToolSet[string] {
  return {
    description: 'agents',
    execute: async (input: unknown, options?: unknown) => {
      readSpawnStarted(options)?.();
      await delay(exploreMs);
      return { strategy: 'merge', text: 'merged fork answer' };
    },
  } as unknown as ToolSet[string];
}

function fakeRunTool(ms: number): ToolSet[string] {
  return {
    description: 'run',
    execute: async () => { await delay(ms); return 'command output'; },
  } as unknown as ToolSet[string];
}

describe('wrapToolsForBackground — fork is spawn-shaped, run/execute_tools are result-shaped', () => {
  test('BACKGROUNDABLE_TOOLS declares the shape axis: agents=spawn, run/execute_tools=result', () => {
    expect(BACKGROUNDABLE_TOOLS.get('agents')?.shape).toBe('spawn');
    expect(BACKGROUNDABLE_TOOLS.get('run')?.shape).toBe('result');
    expect(BACKGROUNDABLE_TOOLS.get('execute_tools')?.shape).toBe('result');
  });

  test('on the interactive surface, a fork detaches the instant it spawns — not after the 30s threshold', async () => {
    const crossings: Array<{ kind: string; at: number }> = [];
    const start = performance.now();
    const jobRunner = fakeJobRunner(BACKGROUND_POLICY.interactive, (kind, promise) => {
      crossings.push({ kind, at: performance.now() - start });
      void promise; // detach: keep the live work alive, exactly like the real runner
      return { detached: true, jobId: 'job-fork' };
    });
    expect(jobRunner.policy.detachSpawnOnStart).toBe(true);

    const raw: ToolSet = { agents: fakeForkTool(150) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner });
    const out = await wrapped.agents!.execute!({ action: 'fork', task: 't' }, {} as never);
    const elapsedMs = performance.now() - start;

    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.kind).toBe('agents');
    // Detached on spawn-confirm — nowhere near the 30_000ms interactive
    // threshold, and well before the 150ms exploration itself finishes.
    expect(elapsedMs).toBeLessThan(100);
    expect(out).toMatchObject({ background: true, jobId: 'job-fork', kind: 'agents' });
  });

  test('on the one-shot surface, a fork rides the timed threshold like everything else — nobody is waiting on a live-session wake to receive an early detach', async () => {
    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY['one-shot'], detachAfterMs: 30 },
      (_kind, promise) => { void promise; return { detached: true, jobId: 'job-fork-osh' }; },
    );
    expect(jobRunner.policy.detachSpawnOnStart).toBe(false);

    const raw: ToolSet = { agents: fakeForkTool(20) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner });
    // The fork finishes (20ms) well inside the one-shot threshold (30ms) —
    // riding the ordinary race, it returns the real result inline.
    const out = await wrapped.agents!.execute!({ action: 'fork', task: 't' }, {} as never);
    expect(out).toEqual({ strategy: 'merge', text: 'merged fork answer' });
  });

  test('a non-fork agents action (staff/ask/list) is not detachable — always runs inline, on either surface', async () => {
    let ran = false;
    const raw: ToolSet = {
      agents: {
        description: 'agents',
        execute: async () => { ran = true; return { subordinates: [] }; },
      } as unknown as ToolSet[string],
    };
    const jobRunner = fakeJobRunner(BACKGROUND_POLICY.interactive, () => {
      throw new Error('must not cross the threshold for a non-fork action');
    });
    const wrapped = wrapToolsForBackground(raw, { jobRunner });
    const out = await wrapped.agents!.execute!({ action: 'list' }, {} as never);
    expect(ran).toBe(true);
    expect(out).toEqual({ subordinates: [] });
  });

  test('run/execute_tools stay result-shaped even on the interactive surface — they race the threshold, never spawn-detach', async () => {
    const crossings: string[] = [];
    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY.interactive, detachAfterMs: 20 },
      (kind, promise) => { crossings.push(kind); void promise; return { detached: true, jobId: 'job-run' }; },
    );
    const raw: ToolSet = { run: fakeRunTool(80) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner });
    const out = await wrapped.run!.execute!({ command: 'sleep 1' }, {} as never);

    // Crossed via the TIMED race (20ms threshold, 80ms work) — not on any
    // spawn announcement, because `run` never calls readSpawnStarted.
    expect(crossings).toEqual(['run']);
    expect(out).toMatchObject({ background: true, jobId: 'job-run', kind: 'run' });
  });

  test('a fast run under the threshold returns inline — the axis never over-detaches ordinary work', async () => {
    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY.interactive, detachAfterMs: 1000 },
      () => { throw new Error('must not cross for fast work'); },
    );
    const raw: ToolSet = { run: fakeRunTool(10) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner });
    const out = await wrapped.run!.execute!({ command: 'ls' }, {} as never);
    expect(out).toBe('command output');
  });
});
