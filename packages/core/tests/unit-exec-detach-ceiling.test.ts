// No execution lane may carry its own deadline: a lane deadline silently outranks whichever detach
// window is in force. The foreground window is a detach trigger, never a kill.
import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { toolExecute, createTestActorsOver } from '@kinu.run/test-utils';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import type { ExecutorProvider } from '../src/execution/types';
import { BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome } from '../src/jobs/index';
import { isBackgroundHandle } from '../src/jobs/threshold';
import { wrapToolsForBackground, type BackgroundableTool } from '../src/jobs/background-wrap';
import { BACKGROUNDABLE_TOOLS } from '../src/orchestrator/background-tools';
import { BackgroundJobRunner } from '../src/jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/index';
import { Inbox } from '../src/orchestrator/inbox';
import { EventLog, initEventsHubTables } from '../src/events/hub/index';
import { Database } from 'bun:sqlite';
import { makeSql, makeExecRaw, makeSqlExec } from './helpers';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import type { Schedule } from '../src/types/primitives';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

interface ExecCall {
  command: string;
  opts?: { cwd?: string; timeout?: number };
}

interface FakeContainer {
  handle: SandboxHandle;
  calls: ExecCall[];
  /** Let the in-flight command exit; it outlasts its deadline by never finishing until called. */
  finish: () => void;
}

const DONE = 'epoch 40/40 done\n';

/** A container that enforces the caller's deadline and kills with the SDK's own message; "outlasts" is an ordering, not a duration. */
function fakeContainer(): FakeContainer {
  const calls: ExecCall[] = [];
  const exit = Promise.withResolvers<{ stdout: string; exitCode: number }>();

  return {
    calls,
    finish: () => exit.resolve({ stdout: DONE, exitCode: 0 }),
    handle: {
      exec: async (command, opts) => {
        if (opts === undefined) calls.push({ command });
        else calls.push({ command, opts });

        if (opts?.timeout === undefined) return exit.promise;
        throw new Error(`Command timeout after ${opts.timeout}ms`);
      },
      readFile: async () => ({ content: '' }),
      writeFile: async () => undefined,
      listFiles: async () => ({ files: [] }),
      deleteFile: async () => undefined,
      exposePort: async (port) => ({ url: `https://p/${port}`, port }),
      unexposePort: async () => undefined,
      getExposedPorts: async () => [],
      ...sandboxHandleLifecycle,
    },
  };
}

/** The screenshot's exact call. */
const TRAINING = 'python3 train.py --epochs 40 2>&1 | tee /workspace/train.log';

interface ShellToolInput { command: string; runtime?: string }

/** A `shell` tool shaped like the real one at `runtime: 'sandbox'`, dispatching to the router's sandbox provider. */
function runToolOverSandbox(provider: ExecutorProvider): ToolSet[string] {
  return tool({
    description: 'shell',
    inputSchema: jsonSchema<ShellToolInput>({
      type: 'object',
      properties: { command: { type: 'string' }, runtime: { type: 'string' } },
      required: ['command'],
    }),
    execute: async (input) => v.parse(v.string(), await provider.tools.exec.execute(input.command, {})),
  });
}

/** A BackgroundJobRunner double over the two members the wrapper reads. */
function fakeJobRunner(
  policy: BackgroundPolicy,
  onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome,
) {
  return { policy, thresholdDeps: () => ({ thresholdMs: policy.detachAfterMs, onThreshold }) };
}

function wrapShellTool(provider: ExecutorProvider, runner: ReturnType<typeof fakeJobRunner>) {
  const wrapped = wrapToolsForBackground(
    { shell: runToolOverSandbox(provider) },
    { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
  );

  const entry = wrapped.shell;

  if (!entry) throw new Error('Expected the shell tool to survive wrapping');

  return toolExecute<ShellToolInput, object | string>(entry);
}

describe('the sandbox lane carries no deadline of its own', () => {
  test("exec sends no timeout — a window bounds the WAIT, never the command", async () => {
    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);

    container.finish();
    const out = await provider.tools.exec.execute(TRAINING, {});

    expect(container.calls).toHaveLength(1);
    // Any deadline here outranks every larger detach window.
    expect(container.calls[0]?.opts?.timeout).toBeUndefined();
    expect(container.calls[0]?.opts?.cwd).toBe('/workspace');
    expect(out).toContain('epoch 40/40 done');
    expect(out).not.toContain('Command timeout');
  });
});

describe("the incident replayed: a long tee'd training run through run → sandbox", () => {
  test('it detaches at the foreground window and the settle carries the real result', async () => {
    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);
    const detached: Array<Promise<unknown>> = [];

    // A zero window makes the race deterministic: the threshold is the only branch that can win.
    const runner = fakeJobRunner(
      { ...BACKGROUND_POLICY.interactive, detachAfterMs: 0 },
      (_kind, promise) => {
        detached.push(promise);

        return { detached: true, jobId: 'job-1' };
      },
    );

    const out = await wrapShellTool(provider, runner)({ command: TRAINING, runtime: 'sandbox' });

    expect(isBackgroundHandle(out)).toBe(true);
    expect(detached).toHaveLength(1);

    container.finish();
    expect(String(await detached[0])).toContain('epoch 40/40 done');
  });

  test('the one-shot window is reachable: no lane ceiling undercuts it', async () => {
    // A turn woken by its own background job is one-shot; with no lane ceiling its work finishes inline.
    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);
    let crossed = 0;

    const runner = fakeJobRunner(
      BACKGROUND_POLICY['one-shot'],
      () => {
        crossed++;

        return { detached: true, jobId: 'job-2' };
      },
    );

    container.finish();
    const out = await wrapShellTool(provider, runner)({ command: TRAINING, runtime: 'sandbox' });

    expect(crossed).toBe(0);
    expect(out).toContain('epoch 40/40 done');
    // The larger window is the one a lane ceiling defeats first.
    expect(BACKGROUND_POLICY['one-shot'].detachAfterMs)
      .toBeGreaterThan(BACKGROUND_POLICY.interactive.detachAfterMs);
  });
});

describe('every long-capable surface is declared backgroundable', () => {
  test('the shell and the code lane both ride the window, on every surface', () => {
    // A confined surface holds only these two and the actor's map is built from them, so `eval` and `shell` cannot diverge.
    const declared: Readonly<Record<string, BackgroundableTool>> = BACKGROUNDABLE_TOOLS;
    expect(declared.shell?.completion).toBe('result');
    expect(declared.eval?.completion).toBe('result');
    expect(declared.shell?.detachable({ command: 'x', runtime: 'sandbox' })).toBe(true);
    expect(declared.eval?.detachable({ code: 'await sandbox.exec("x")' })).toBe(true);
  });
});

describe('the settle wakes the agent — the whole chain, no doubles in the middle', () => {
  test("the training run detaches, settles, and enqueues the wake carrying its result", async () => {
    // The real runner, Inbox and durable store over the real sandbox lane; only the fiber and platform host are doubles.
    const db = new Database(':memory:');
    initBackgroundJobsTable(makeExecRaw(db));
    const hubSql = makeSqlExec(db);
    initEventsHubTables(hubSql);
    // One actor for job store and inbox: two handles would signal an inbox nothing drains.
    const actor = createTestActorsOver(db).main;
    const store = new BackgroundJobStore(makeSql(db), actor);

    const bodies: Array<Promise<unknown>> = [];

    const fiber: Schedule['fiber'] = async (_name, fn) => {
      const body = fn({ stash: () => {}, snapshot: null });
      bodies.push(body);

      return body;
    };

    const enqueued: ProgrammaticTurn[] = [];

    const host: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async (turn) => {
        enqueued.push(turn);

        return { status: 'queued' };
      },
      turnInFlight: () => false,
      setTimer: () => {},
    };

    const runner = new BackgroundJobRunner({
      store, fiber, inbox: new Inbox(host), eventLog: new EventLog(hubSql, actor),
      scheduleDrain: () => {}, logActivity: () => {},
      // A zero window: the crossing is decided by the command not having finished, not by waiting.
      policy: () => ({ ...BACKGROUND_POLICY.interactive, detachAfterMs: 0 }),
    });

    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);

    const wrapped = wrapToolsForBackground(
      { shell: runToolOverSandbox(provider) },
      { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
    );

    const entry = wrapped.shell;

    if (!entry) throw new Error('Expected the shell tool to survive wrapping');

    const out = await toolExecute<ShellToolInput, object | string>(entry)({
      command: TRAINING, runtime: 'sandbox',
    });

    expect(isBackgroundHandle(out)).toBe(true);
    const jobId = isBackgroundHandle(out) ? out.jobId : '';
    expect(store.get(jobId)?.status).toBe('running');

    container.finish();
    await Promise.all(bodies);

    const job = store.get(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.result).toContain('epoch 40/40 done');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.metadata?.kinuEvent).toBe('background_job');
    expect(enqueued[0]?.metadata?.status).toBe('completed');
    expect(enqueued[0]?.text).toContain(jobId);
  });
});
