// wrapToolsForBackground — the two shapes of backgroundable work, one wrapper.
//
// Defect A (see bench artifact PROGRAM-LEDGER context): a fork sat 30s in the
// interactive chat doing nothing visible before the OLD wrapper detached it,
// because every backgroundable tool rode the SAME timed threshold regardless
// of whether its duration was genuinely unknown (`shell`, `eval`) or
// long by construction (`agents` fork). This file pins the fix at the wiring
// layer: `agents` fork is 'spawn'-shaped and detaches the moment its spawn is
// receive the wake (policy.wakesAfterTurn); `shell`/`eval` stay
// 'result'-shaped and always ride the timed race, on every surface.
import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { handClock, toolExecute } from '@kinu.run/test-utils';
import { BACKGROUNDABLE_TOOLS } from '../src/orchestrator/background-tools';
import { wrapToolsForBackground } from '../src/jobs/background-wrap';
import { readSpawnStarted, BACKGROUND_POLICY, invocationBackgroundPolicy, type BackgroundPolicy, type DetachOutcome } from '../src/jobs/index';
import type { Clock } from '../src/types/clock';


function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();

  return { held: promise, release: resolve };
}

type TestToolResult = object | string;

interface ForkInput { action: string; task?: string }

interface ShellToolInput { command: string }

/** A minimal BackgroundJobRunner double — only the two members the wrapper
 *  reads (`thresholdDeps`, `policy`), over a caller-supplied onThreshold so
 *  each test observes exactly when the wrapper crossed. */
function fakeJobRunner(
  policy: BackgroundPolicy,
  onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome,
  clock?: Clock,
) {
  return {
    policy,
    thresholdDeps: () => ({ thresholdMs: policy.detachAfterMs, onThreshold, clock }),
  };
}

/** A fork tool shaped like the real `agents` tool's execute: it announces its
 *  spawn (readSpawnStarted) right after "validating" input, then the
 *  exploration itself runs long. Mirrors agents-tool.ts's own call to
 *  readSpawnStarted(toolOptions)?.() before strat.explore(). */
function fakeForkTool(exploration: Promise<void>, onExplored?: () => void): ToolSet[string] {
  return tool({
    description: 'agents',
    inputSchema: jsonSchema<ForkInput>({
      type: 'object', properties: { action: { type: 'string' }, task: { type: 'string' } },
      required: ['action'],
    }),
    execute: async (_input, options) => {
      readSpawnStarted(options)?.();
      await exploration;
      onExplored?.();

      return { strategy: 'merge', text: 'merged fork answer' };
    },
  });
}

function fakeShellTool(command: Promise<void>): ToolSet[string] {
  return tool({
    description: 'shell',
    inputSchema: jsonSchema<ShellToolInput>({
      type: 'object', properties: { command: { type: 'string' } }, required: ['command'],
    }),
    execute: async () => {
      await command;

      return 'command output';
    },
  });
}

function executeTool<Args>(tools: ToolSet, name: string) {
  const entry = tools[name];

  if (!entry) throw new Error(`Expected ${name} tool to be registered`);

  return toolExecute<Args, TestToolResult>(entry);
}

describe('wrapToolsForBackground — fork is spawn-shaped, run/eval are result-shaped', () => {
  test('BACKGROUNDABLE_TOOLS declares the completion axis: agents=spawn, run/eval=result', () => {
    expect(BACKGROUNDABLE_TOOLS.agents?.completion).toBe('spawn');
    expect(BACKGROUNDABLE_TOOLS.shell?.completion).toBe('result');
    expect(BACKGROUNDABLE_TOOLS.eval?.completion).toBe('result');
  });

  test('on the interactive surface, a fork detaches the instant it spawns — not after the 30s threshold', async () => {
    const crossings: string[] = [];
    const detached: Promise<unknown>[] = [];
    let explored = false;
    const exploringAtDetach: boolean[] = [];

    const jobRunner = fakeJobRunner(BACKGROUND_POLICY.interactive, (kind, promise) => {
      crossings.push(kind);
      exploringAtDetach.push(!explored);
      detached.push(promise);

      return { detached: true, jobId: 'job-fork' };
    });

    expect(jobRunner.policy.wakesAfterTurn).toBe(true);

    const exploration = gate();
    const raw: ToolSet = { agents: fakeForkTool(exploration.held, () => { explored = true; }) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<ForkInput>(wrapped, 'agents')({ action: 'fork', task: 't' });

    expect(crossings).toEqual(['agents']);
    // Detached on spawn-confirm: the exploration was still running when the
    // runner took the work — it is still held here. The timed path would have
    // waited out the 30 s interactive threshold. An ordering, not a wall-clock
    // bound: scheduler latency under load cannot move a timer callback ahead
    // of the microtasks the announce resolves.
    expect(exploringAtDetach).toEqual([true]);
    expect(out).toMatchObject({ background: true, jobId: 'job-fork', kind: 'agents' });
    exploration.release();
    await Promise.all(detached);
  });

  test('on the one-shot surface a fork NEVER detaches — even one that far outruns the threshold returns its own answer', async () => {
    // The one-shot defect: a fork whose work outlived detachAfterMs was handed
    // to the background runner, so the model got a handle instead of an answer
    // and teardown abandoned the job a grace later. On a surface with no wake
    // there is nobody to deliver that result to, so the detach could only ever
    // throw the work away — a tree-search fork was measured doing exactly that,
    // 4 of 40 iterations before `bg_jobs_abandoned`.
    const crossings: string[] = [];
    const detached: Promise<unknown>[] = [];

    const timer = handClock();

    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY['one-shot'], detachAfterMs: 10 },
      (kind, promise) => {
        crossings.push(kind);
        detached.push(promise);

        return { detached: true, jobId: 'job-fork-osh' };
      },
      timer,
    );

    expect(jobRunner.policy.wakesAfterTurn).toBe(false);

    // The window passes while the exploration is still running, and only
    // then does the fork answer: the answer arrives on the inline path anyway.
    const exploration = gate();
    const raw: ToolSet = { agents: fakeForkTool(exploration.held) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const pending = executeTool<ForkInput>(wrapped, 'agents')({ action: 'fork', task: 't' });
    timer.tick();
    exploration.release();
    const out = await pending;

    expect(crossings).toEqual([]);
    expect(out).toEqual({ strategy: 'merge', text: 'merged fork answer' });
    await Promise.all(detached);
  });

  test('the one-shot inline rule is spawn-shaped only — result-shaped work still detaches there', async () => {
    // `shell`/`eval` keep the timed race on every surface: what crosses
    // there is the genuinely non-terminating work (a server, a VM) whose
    // result was never the point.
    const crossings: string[] = [];
    const detached: Promise<unknown>[] = [];

    const timer = handClock();

    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY['one-shot'], detachAfterMs: 10 },
      (kind, promise) => {
        crossings.push(kind);
        detached.push(promise);

        return { detached: true, jobId: 'job-run' };
      },
      timer,
    );

    const command = gate();
    const wrapped = wrapToolsForBackground({ shell: fakeShellTool(command.held) }, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const pending = executeTool<ShellToolInput>(wrapped, 'shell')({ command: 'serve' });
    timer.tick();
    const out = await pending;

    expect(crossings).toEqual(['shell']);
    expect(out).toMatchObject({ background: true, jobId: 'job-run', kind: 'shell' });
    command.release();
    await Promise.all(detached);
  });

  test('a non-fork agents action (hire/ask/list) is not detachable — always runs inline, on either surface', async () => {
    let ran = false;

    const raw: ToolSet = {
      agents: tool({
        description: 'agents',
        inputSchema: jsonSchema<ForkInput>({
          type: 'object', properties: { action: { type: 'string' } }, required: ['action'],
        }),
        execute: async () => {
          ran = true;

          return { subordinates: [] };
        },
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

  test('run/eval stay result-shaped even on the interactive surface — they race the threshold, never spawn-detach', async () => {
    const crossings: string[] = [];
    const detached: Promise<unknown>[] = [];

    const timer = handClock();

    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY.interactive, detachAfterMs: 20 },
      (kind, promise) => {
        crossings.push(kind);
        detached.push(promise);

        return { detached: true, jobId: 'job-run' };
      },
      timer,
    );

    const command = gate();
    const raw: ToolSet = { shell: fakeShellTool(command.held) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const pending = executeTool<ShellToolInput>(wrapped, 'shell')({ command: 'sleep 1' });
    timer.tick();
    const out = await pending;

    // Crossed via the TIMED race (the window fired while the command was
    // held) — not on any spawn announcement, because `shell` never calls
    // readSpawnStarted.
    expect(crossings).toEqual(['shell']);
    expect(out).toMatchObject({ background: true, jobId: 'job-run', kind: 'shell' });
    command.release();
    await Promise.all(detached);
  });

  test('a fast run under the threshold returns inline — the axis never over-detaches ordinary work', async () => {
    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY.interactive, detachAfterMs: 1000 },
      () => { throw new Error('must not cross for fast work'); },
      handClock(),
    );

    // The window never fires: fast work is work that settles first.
    const raw: ToolSet = { shell: fakeShellTool(Promise.resolve()) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool<ShellToolInput>(wrapped, 'shell')({ command: 'ls' });
    expect(out).toBe('command output');
  });
});

describe('invocationBackgroundPolicy — the surface and session durability compose', () => {
  // Two independent facts decide one invocation's policy. The SURFACE says who
  // watches the stream, which is what the detach threshold costs. SESSION
  // DURABILITY says whether a wake can arrive after the turn, which is the only
  // thing `wakesAfterTurn` has ever meant. They come apart on a Durable Object:
  // its unwatched turns (a drain, a wake itself, a timer) have no exit — alarms
  // deliver wakes with nobody connected — so it takes the one-shot thresholds
  // with wakes enabled. Keying both halves off one string is what gave cloud
  // programmatic turns `wakesAfterTurn: false` on the very turn that proved a
  // wake had arrived.
  test('the CLI one-shot process keeps its measured no-wake policy', () => {
    expect(invocationBackgroundPolicy('one-shot', false)).toEqual(BACKGROUND_POLICY['one-shot']);
  });

  test('a durable host on an unwatched surface detaches spawns — their wakes have a reader', () => {
    const policy = invocationBackgroundPolicy('one-shot', true);
    // Only the wake half moves: an unwatched turn still runs foreground work to
    // the one-shot threshold, because truncating it buys nothing.
    expect(policy.detachAfterMs).toBe(BACKGROUND_POLICY['one-shot'].detachAfterMs);
    expect(policy.settleGraceMs).toBe(BACKGROUND_POLICY['one-shot'].settleGraceMs);
    expect(policy.wakesAfterTurn).toBe(true);
  });

  test('the interactive rows pass through unchanged in both answers', () => {
    expect(invocationBackgroundPolicy('interactive', true)).toEqual(BACKGROUND_POLICY.interactive);
    expect(invocationBackgroundPolicy('interactive', true).detachAfterMs)
      .toBe(BACKGROUND_POLICY.interactive.detachAfterMs);
  });
});
