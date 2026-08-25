// Two invariants about long work, and the production failure that broke both at
// once.
//
// The incident (owner screenshot, workspace my-ai-engineer-b3b8b792): a tee'd
// training script dispatched through `run` at `runtime: 'sandbox'` came back
// `CommandError: … Command timeout after 60000ms`. Not a handle, not an answer —
// a killed command. Two separate facts produced it:
//
//   1. The 60000 was OURS. `createSandboxExecutor` sent `timeout: 60_000` on
//      every sandbox exec, from the day the SDK landed. The container echoed the
//      number we gave it back in its own error text, which is why that string
//      appears nowhere in this repository or in the SDK client.
//   2. A detach window ABOVE a lane's ceiling can never fire. The interactive
//      window is 30s and would have won; the one-shot window is 300s, and a turn
//      driven by a background-job wake IS one-shot. So the first detach in a
//      session guaranteed the next turn's long work died at 60s instead of
//      detaching — the exact sequence the model described when it said the 30s
//      window "only triggered for the smoke/unit tests".
//
// The invariant is therefore a RELATION, not a number: no execution lane may
// carry a deadline of its own, because a lane deadline silently outranks
// whichever detach window is in force. The foreground window stays what it
// always was — a detach trigger, never a kill.
import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { toolExecute } from '@kinu.run/test-utils';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import type { ExecutorProvider } from '../src/execution/types';
import { BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome } from '../src/jobs/index';
import { isBackgroundHandle } from '../src/jobs/threshold';
import { wrapToolsForBackground, type BackgroundableTool } from '../src/jobs/background-wrap';
import { BACKGROUNDABLE_TOOLS } from '../src/orchestrator/background-tools';
import { BackgroundJobRunner } from '../src/jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/index';
import { SignalDelivery } from '../src/orchestrator/signals';
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
  /** Let the in-flight command exit. Nothing here is time-driven: the command
   *  outlasts its deadline by never finishing until the test says so. */
  finish: () => void;
}

const DONE = 'epoch 40/40 done\n';

/**
 * A container that behaves like the real one on the one axis that matters: it
 * enforces whatever deadline the caller sent, and kills the command with the
 * SDK's own message interpolating the number it was given. A command that is
 * still running when its deadline arrives is modelled as one that has not been
 * `finish()`ed — so "outlasts its deadline" is an ordering, not a duration.
 */
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

interface RunInput { command: string; runtime?: string }

/** A `run` tool shaped like the real one at `runtime: 'sandbox'`: it dispatches
 *  to the router's sandbox provider, which is where the incident ran. */
function runToolOverSandbox(provider: ExecutorProvider): ToolSet[string] {
  return tool({
    description: 'run',
    inputSchema: jsonSchema<RunInput>({
      type: 'object',
      properties: { command: { type: 'string' }, runtime: { type: 'string' } },
      required: ['command'],
    }),
    execute: async (input) => String(await provider.tools.exec.execute(input.command, {})),
  });
}

/** A BackgroundJobRunner double over the two members the wrapper reads. */
function fakeJobRunner(
  policy: BackgroundPolicy,
  onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome,
) {
  return { policy, thresholdDeps: () => ({ thresholdMs: policy.detachAfterMs, onThreshold }) };
}

function wrapRun(provider: ExecutorProvider, runner: ReturnType<typeof fakeJobRunner>) {
  const wrapped = wrapToolsForBackground(
    { run: runToolOverSandbox(provider) },
    { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
  );
  const entry = wrapped['run'];
  if (!entry) throw new Error('Expected the run tool to survive wrapping');
  return toolExecute<RunInput, object | string>(entry);
}

describe('the sandbox lane carries no deadline of its own', () => {
  test("exec sends no timeout — a window bounds the WAIT, never the command", async () => {
    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);

    container.finish();
    const out = await provider.tools.exec.execute(TRAINING, {});

    expect(container.calls).toHaveLength(1);
    // The regression in one assertion: any number here is a work-killer,
    // because it outranks every detach window larger than it.
    expect(container.calls[0]?.opts?.timeout).toBeUndefined();
    // The default cwd is a separate contract and must survive the removal.
    expect(container.calls[0]?.opts?.cwd).toBe('/workspace');
    // And the command's own output comes back, not the container's kill notice.
    expect(String(out)).toContain('epoch 40/40 done');
    expect(String(out)).not.toContain('Command timeout');
  });
});

describe("the incident replayed: a long tee'd training run through run → sandbox", () => {
  test('it detaches at the foreground window and the settle carries the real result', async () => {
    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);
    const detached: Array<Promise<unknown>> = [];
    // A zero window makes the race deterministic: the command has not finished,
    // so the threshold is the only branch that can win. No guessed sleep.
    const runner = fakeJobRunner(
      { ...BACKGROUND_POLICY.interactive, detachAfterMs: 0 },
      (_kind, promise) => { detached.push(promise); return { detached: true, jobId: 'job-1' }; },
    );

    const out = await wrapRun(provider, runner)({ command: TRAINING, runtime: 'sandbox' });

    // The model is handed a handle and keeps working.
    expect(isBackgroundHandle(out)).toBe(true);
    expect(detached).toHaveLength(1);

    // …and the work it was told is "still running, not cancelled" really is.
    // Before the fix this settled as `Command timeout after 60000ms`.
    container.finish();
    expect(String(await detached[0])).toContain('epoch 40/40 done');
  });

  test('the one-shot window is reachable: no lane ceiling undercuts it', async () => {
    // The self-reinforcing half of the incident. A turn woken by its own
    // background job is one-shot, whose window is 300s. Against a 60s lane
    // ceiling that window was unreachable and the work was killed; with no lane
    // ceiling the work finishes inline, which is what the one-shot policy was
    // measured to want.
    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);
    let crossed = 0;
    const runner = fakeJobRunner(
      BACKGROUND_POLICY['one-shot'],
      () => { crossed++; return { detached: true, jobId: 'job-2' }; },
    );

    container.finish();
    const out = await wrapRun(provider, runner)({ command: TRAINING, runtime: 'sandbox' });

    expect(crossed).toBe(0);
    expect(String(out)).toContain('epoch 40/40 done');
    // Pinned because the relation is the invariant: the larger window is the one
    // a lane ceiling silently defeats first.
    expect(BACKGROUND_POLICY['one-shot'].detachAfterMs)
      .toBeGreaterThan(BACKGROUND_POLICY.interactive.detachAfterMs);
  });
});

describe('every long-capable surface is declared backgroundable', () => {
  test('the shell and the code lane both ride the window, on every surface', () => {
    // A confined surface (a swarm node, a head) holds only these two, and the
    // actor's map is built FROM them — so the sandbox namespace reached through
    // `execute_tools` and the shell reached through `run` cannot diverge. Read
    // through the declared contract, which is what the wrapper indexes.
    const declared: Readonly<Record<string, BackgroundableTool>> = BACKGROUNDABLE_TOOLS;
    expect(declared['run']?.completion).toBe('result');
    expect(declared['execute_tools']?.completion).toBe('result');
    expect(declared['run']?.detachable({ command: 'x', runtime: 'sandbox' })).toBe(true);
    expect(declared['execute_tools']?.detachable({ code: 'await sandbox.exec("x")' })).toBe(true);
  });
});

describe('the settle wakes the agent — the whole chain, no doubles in the middle', () => {
  test("the training run detaches, settles, and enqueues the wake carrying its result", async () => {
    // The same seams unit-background-job-runner.test.ts asserts on, driven from
    // the real sandbox lane instead of a bare promise: the REAL runner, the REAL
    // SignalDelivery, the REAL durable store. Only the fiber and the platform
    // host are doubles, because a DO is the one thing a unit cannot have.
    const db = new Database(':memory:');
    initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
    const hubSql = makeSqlExec(db);
    initEventsHubTables(hubSql);
    const store = new BackgroundJobStore(makeSql(db));

    const bodies: Array<Promise<unknown>> = [];
    const fiber: Schedule['fiber'] = async (_name, fn) => {
      const body = fn({ stash: () => {}, snapshot: null });
      bodies.push(body);
      return body;
    };
    const enqueued: ProgrammaticTurn[] = [];
    const host: BackendHost = {
      broadcast: () => {},
      enqueueTurn: async (turn) => { enqueued.push(turn); return { status: 'queued' }; },
      turnInFlight: () => false,
      setTimer: () => {},
    };
    const runner = new BackgroundJobRunner({
      store, fiber, signals: new SignalDelivery(host), eventLog: new EventLog(hubSql),
      scheduleDrain: () => {}, logActivity: () => {},
      // A zero window so the crossing is decided by the command not having
      // finished, never by how long a test waited.
      policy: () => ({ ...BACKGROUND_POLICY.interactive, detachAfterMs: 0 }),
    });

    const container = fakeContainer();
    const provider = createSandboxExecutor(container.handle);
    const wrapped = wrapToolsForBackground(
      { run: runToolOverSandbox(provider) },
      { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
    );
    const entry = wrapped['run'];
    if (!entry) throw new Error('Expected the run tool to survive wrapping');
    const out = await toolExecute<RunInput, object | string>(entry)({
      command: TRAINING, runtime: 'sandbox',
    });

    expect(isBackgroundHandle(out)).toBe(true);
    const jobId = isBackgroundHandle(out) ? out.jobId : '';
    expect(store.get(jobId)?.status).toBe('running');

    // The container finishes the training run long after the turn let go of it.
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
