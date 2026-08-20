// wrapToolsForBackground — the two shapes of backgroundable work, one wrapper.
//
// Defect A (see bench artifact PROGRAM-LEDGER context): a fork sat 30s in the
// interactive chat doing nothing visible before the OLD wrapper detached it,
// because every backgroundable tool rode the SAME timed threshold regardless
// of whether its duration was genuinely unknown (`run`, `execute_tools`) or
// long by construction (`agents` fork). This file pins the fix at the wiring
// layer: `agents` fork is 'spawn'-shaped and detaches the moment its spawn is
// confirmed — but ONLY on a surface whose session outlives the turn to
// receive the wake (policy.wakesAfterTurn); `run`/`execute_tools` stay
// 'result'-shaped and always ride the timed race, on every surface.
import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { toolExecute } from '@kinu/test-utils';
import { BACKGROUNDABLE_TOOLS } from '../src/orchestrator/background-tools';
import { wrapToolsForBackground } from '../src/jobs/background-wrap';
import { readSpawnStarted, BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome } from '../src/jobs/index';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
type TestToolResult = object | string;
interface ForkInput { action: string; task?: string }
interface RunInput { command: string }

/** A minimal BackgroundJobRunner double — only the two members the wrapper
 *  reads (`thresholdDeps`, `policy`), over a caller-supplied onThreshold so
 *  each test observes exactly when the wrapper crossed. */
function fakeJobRunner(policy: BackgroundPolicy, onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome) {
  return {
    policy,
    thresholdDeps: (_kind: string) => ({ thresholdMs: policy.detachAfterMs, onThreshold }),
  };
}

/** A fork tool shaped like the real `agents` tool's execute: it announces its
 *  spawn (readSpawnStarted) right after "validating" input, then the
 *  exploration itself runs long. Mirrors agents-tool.ts's own call to
 *  readSpawnStarted(toolOptions)?.() before strat.explore(). */
function fakeForkTool(exploreMs: number): ToolSet[string] {
  return tool({
    description: 'agents',
    inputSchema: jsonSchema<ForkInput>({
      type: 'object', properties: { action: { type: 'string' }, task: { type: 'string' } },
      required: ['action'],
    }),
    execute: async (_input, options) => {
      readSpawnStarted(options)?.();
      await delay(exploreMs);
      return { strategy: 'merge', text: 'merged fork answer' };
    },
  });
}

function fakeRunTool(ms: number): ToolSet[string] {
  return tool({
    description: 'run',
    inputSchema: jsonSchema<RunInput>({
      type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
    }),
    execute: async () => { await delay(ms); return 'command output'; },
  });
}

function executeTool<Args>(tools: ToolSet, name: string) {
  const entry = tools[name];
  if (!entry) throw new Error(`Expected ${name} tool to be registered`);
  return toolExecute<Args, TestToolResult>(entry);
}

describe('wrapToolsForBackground — fork is spawn-shaped, run/execute_tools are result-shaped', () => {
  test('BACKGROUNDABLE_TOOLS declares the completion axis: agents=spawn, run/execute_tools=result', () => {
    expect(BACKGROUNDABLE_TOOLS['agents']?.completion).toBe('spawn');
    expect(BACKGROUNDABLE_TOOLS['run']?.completion).toBe('result');
    expect(BACKGROUNDABLE_TOOLS['execute_tools']?.completion).toBe('result');
  });

  test('on the interactive surface, a fork detaches the instant it spawns — not after the 30s threshold', async () => {
    const crossings: Array<{ kind: string; at: number }> = [];
    const start = performance.now();
    const jobRunner = fakeJobRunner(BACKGROUND_POLICY.interactive, (kind, promise) => {
      crossings.push({ kind, at: performance.now() - start });
      void promise; // detach: keep the live work alive, exactly like the real runner
      return { detached: true, jobId: 'job-fork' };
    });
    expect(jobRunner.policy.wakesAfterTurn).toBe(true);

    const raw: ToolSet = { agents: fakeForkTool(150) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<ForkInput>(wrapped, 'agents')({ action: 'fork', task: 't' });
    const elapsedMs = performance.now() - start;

    expect(crossings).toHaveLength(1);
    expect(crossings[0]?.kind).toBe('agents');
    // Detached on spawn-confirm — nowhere near the 30_000ms interactive
    // threshold, and well before the 150ms exploration itself finishes.
    expect(elapsedMs).toBeLessThan(100);
    expect(out).toMatchObject({ background: true, jobId: 'job-fork', kind: 'agents' });
  });

  test('on the one-shot surface a fork NEVER detaches — even one that far outruns the threshold returns its own answer', async () => {
    // The one-shot defect: a fork whose work outlived detachAfterMs was handed
    // to the background runner, so the model got a handle instead of an answer
    // and teardown abandoned the job a grace later. On a surface with no wake
    // there is nobody to deliver that result to, so the detach could only ever
    // throw the work away — a tree-search fork was measured doing exactly that,
    // 4 of 40 iterations before `bg_jobs_abandoned`.
    const crossings: string[] = [];
    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY['one-shot'], detachAfterMs: 10 },
      (kind, promise) => { crossings.push(kind); void promise; return { detached: true, jobId: 'job-fork-osh' }; },
    );
    expect(jobRunner.policy.wakesAfterTurn).toBe(false);

    const raw: ToolSet = { agents: fakeForkTool(60) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<ForkInput>(wrapped, 'agents')({ action: 'fork', task: 't' });

    expect(crossings).toEqual([]);
    expect(out).toEqual({ strategy: 'merge', text: 'merged fork answer' });
  });

  test('the one-shot inline rule is spawn-shaped only — result-shaped work still detaches there', async () => {
    // `run`/`execute_tools` keep the timed race on every surface: what crosses
    // there is the genuinely non-terminating work (a server, a VM) whose
    // result was never the point.
    const crossings: string[] = [];
    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY['one-shot'], detachAfterMs: 10 },
      (kind, promise) => { crossings.push(kind); void promise; return { detached: true, jobId: 'job-run' }; },
    );
    const wrapped = wrapToolsForBackground({ run: fakeRunTool(60) }, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<RunInput>(wrapped, 'run')({ command: 'serve' });

    expect(crossings).toEqual(['run']);
    expect(out).toMatchObject({ background: true, jobId: 'job-run', kind: 'run' });
  });

  test('a non-fork agents action (hire/ask/list) is not detachable — always runs inline, on either surface', async () => {
    let ran = false;
    const raw: ToolSet = {
      agents: tool({
        description: 'agents',
        inputSchema: jsonSchema<ForkInput>({
          type: 'object', properties: { action: { type: 'string' } }, required: ['action'],
        }),
        execute: async () => { ran = true; return { subordinates: [] }; },
      }),
    };
    const jobRunner = fakeJobRunner(BACKGROUND_POLICY.interactive, () => {
      throw new Error('must not cross the threshold for a non-fork action');
    });
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<ForkInput>(wrapped, 'agents')({ action: 'list' });
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
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<RunInput>(wrapped, 'run')({ command: 'sleep 1' });

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
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<RunInput>(wrapped, 'run')({ command: 'ls' });
    expect(out).toBe('command output');
  });
});
