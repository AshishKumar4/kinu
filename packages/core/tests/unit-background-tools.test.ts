// Spawn-shaped work (`agents` fork) detaches on spawn announcement where a wake can deliver the
// result; result-shaped work (`shell`, `eval`) always rides the timed race.
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

/** Records the crossing and detaches it under `jobId`. */
function recordDetach(
  crossings: string[], detached: Promise<unknown>[], jobId: string,
): (kind: string, promise: Promise<unknown>) => DetachOutcome {
  return (kind, promise) => {
    crossings.push(kind);
    detached.push(promise);

    return { detached: true, jobId };
  };
}

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

/** Announces its spawn (readSpawnStarted) before a long exploration, like agents-tool.ts. */
function fakeForkTool(exploration: Promise<void>, onExplored?: () => void): ToolSet[string] {
  return tool({
    description: 'agents',
    inputSchema: jsonSchema<ForkInput>({
      type: 'object', properties: { action: { type: 'string' }, task: { type: 'string' } },
      required: ['action'],
    }),
    execute: async (_input, options) => {
      readSpawnStarted({ toolOptions: options })?.();
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

function executeTool(tools: ToolSet, name: string) {
  const entry = tools[name];

  if (!entry) throw new Error(`Expected ${name} tool to be registered`);

  return toolExecute<ForkInput | ShellToolInput, TestToolResult>(entry);
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
    const out = await executeTool(wrapped, 'agents')({ action: 'fork', task: 't' });

    expect(crossings).toEqual(['agents']);
    // An ordering, not a wall-clock bound: the exploration is still held at detach.
    expect(exploringAtDetach).toEqual([true]);
    expect(out).toMatchObject({ background: true, jobId: 'job-fork', kind: 'agents' });
    exploration.release();
    await Promise.all(detached);
  });

  test('on the one-shot surface a fork NEVER detaches — even one that far outruns the threshold returns its own answer', async () => {
    // Without a wake, a detached fork's result has nowhere to go, so it must answer inline.
    const crossings: string[] = [];
    const detached: Promise<unknown>[] = [];

    const timer = handClock();

    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY['one-shot'], detachAfterMs: 10 },
      recordDetach(crossings, detached, 'job-fork-osh'),
      timer,
    );

    expect(jobRunner.policy.wakesAfterTurn).toBe(false);

    const exploration = gate();
    const raw: ToolSet = { agents: fakeForkTool(exploration.held) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const pending = executeTool(wrapped, 'agents')({ action: 'fork', task: 't' });
    timer.tick();
    exploration.release();
    const out = await pending;

    expect(crossings).toEqual([]);
    expect(out).toEqual({ strategy: 'merge', text: 'merged fork answer' });
    await Promise.all(detached);
  });

  test('the one-shot inline rule is spawn-shaped only — result-shaped work still detaches there', async () => {
    const crossings: string[] = [];
    const detached: Promise<unknown>[] = [];

    const timer = handClock();

    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY['one-shot'], detachAfterMs: 10 },
      recordDetach(crossings, detached, 'job-run'),
      timer,
    );

    const command = gate();
    const wrapped = wrapToolsForBackground({ shell: fakeShellTool(command.held) }, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const pending = executeTool(wrapped, 'shell')({ command: 'serve' });
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
    const out = await executeTool(wrapped, 'agents')({ action: 'list' });
    expect(ran).toBe(true);
    expect(out).toEqual({ subordinates: [] });
  });

  test('run/eval stay result-shaped even on the interactive surface — they race the threshold, never spawn-detach', async () => {
    const crossings: string[] = [];
    const detached: Promise<unknown>[] = [];

    const timer = handClock();

    const jobRunner = fakeJobRunner(
      { ...BACKGROUND_POLICY.interactive, detachAfterMs: 20 },
      recordDetach(crossings, detached, 'job-run'),
      timer,
    );

    const command = gate();
    const raw: ToolSet = { shell: fakeShellTool(command.held) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const pending = executeTool(wrapped, 'shell')({ command: 'sleep 1' });
    timer.tick();
    const out = await pending;

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

    const raw: ToolSet = { shell: fakeShellTool(Promise.resolve()) };
    const wrapped = wrapToolsForBackground(raw, { jobRunner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS });
    const out = await executeTool(wrapped, 'shell')({ command: 'ls' });
    expect(out).toBe('command output');
  });
});

describe('invocationBackgroundPolicy — the surface and session durability compose', () => {
  // Surface decides the detach threshold; session durability decides `wakesAfterTurn`.
  test('the CLI one-shot process keeps its measured no-wake policy', () => {
    expect(invocationBackgroundPolicy('one-shot', false)).toEqual(BACKGROUND_POLICY['one-shot']);
  });

  test('a durable host on an unwatched surface detaches spawns — their wakes have a reader', () => {
    const policy = invocationBackgroundPolicy('one-shot', true);
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
