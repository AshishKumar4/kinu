// No execution lane may carry its own deadline: a lane deadline silently outranks whichever detach
// window is in force. The foreground window is a detach trigger, never a kill.
import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { toolExecute, createTestActorsOver, handClock, present } from '@kinu.run/test-utils';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import { createDeviceTunnelExecutor } from '../src/execution/device-tunnel-executor';
import { createHubDeviceTransport, type DeviceHubClient } from '../src/execution/hub-device-transport';
import type { DeviceExecOutput } from '../src/execution/device-tunnel';
import type { ExecutorProvider } from '../src/execution/types';
import { BACKGROUND_POLICY, type BackgroundPolicy, type DetachOutcome } from '../src/jobs/index';
import { isBackgroundHandle } from '../src/jobs/threshold';
import { wrapToolsForBackground, type BackgroundableTool } from '../src/jobs/background-wrap';
import { BACKGROUNDABLE_TOOLS } from '../src/orchestrator/background-tools';
import { BackgroundJobRunner, type BackgroundJobRunnerDeps } from '../src/jobs/runner';
import { recordServingJobs, type PortHolders } from '../src/jobs/serving';
import { followJobOutput, JOB_OUTPUT_EVENT, JobOutputFeeds, type JobOutputFrame, type JobOutputTail } from '../src/jobs/live-output';
import { REAL_CLOCK } from '../src/types/clock';
import { listBackgroundJobs } from '../src/read-models/background-jobs';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/index';
import { Inbox } from '../src/orchestrator/inbox';
import { EventLog, initEventsHubTables } from '../src/events/hub/index';
import { Database } from 'bun:sqlite';
import { conversationsFor, createTestRuntime, makeSql, makeExecRaw, makeSqlExec } from './helpers';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import type { OutputChunk, OutputSink, Schedule, Shell, ShellExecResult } from '../src/types/primitives';
import { withApprovalGatedShell } from '../src/execution/approval';
import { DefaultExecutionRouter } from '../src/execution/router';
import { JOB_STAMP_ENV } from '../src/types/jobs';
import { createShellSession } from '../src/safety/approval-gate';
import { buildBuiltinTools } from '../src/tools/builtins';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

/** A frame's window and a listing's tail, as the feed caps them. */
const WINDOW_CHARS = 16_384;

const TAIL_CHARS = 16_384;

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
      exposePort: async (port) => ({ url: `https://p/${port}`, port, route: { reached: true } }),
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
  return {
    policy, thresholdDeps: () => ({ thresholdMs: policy.detachAfterMs, onThreshold }), output: new JobOutputFeeds({ clock: REAL_CLOCK, send: () => {} }),
    foreground: new Set<AbortController>(),
  };
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

/** The real runner, Inbox and durable store, with a zero window unless `deps` says otherwise; only the fiber and
 *  platform host are doubles. */
function wholeChainRunner(deps: (store: BackgroundJobStore) => Partial<BackgroundJobRunnerDeps> = () => ({})) {
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
    ...deps(store),
  });

  return { runner, store, bodies, enqueued, db };
}

describe('the settle wakes the agent — the whole chain, no doubles in the middle', () => {
  test("the training run detaches, settles, and enqueues the wake carrying its result", async () => {
    const { runner, store, bodies, enqueued } = wholeChainRunner();
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

describe("a detached workspace command and the agent's next one", () => {
  // eval-order-book-1-n99f4k, staging f75f06932, 2026-10-01: a `find /` outran the window and was detached, yet every
  // later `ls`, `pwd` and `echo hello` waited behind it in the agent's shell session, outran the window in turn, and
  // the eight such jobs filled the cap.
  test('the next command runs at once, and the detached one keeps none of its cd', async () => {
    const { runner, store, bodies } = wholeChainRunner();
    const serving = Promise.withResolvers<ShellExecResult>();

    // Nimbus's named shell: the first command serves until the suite stops it; any other answers at once.
    const workspaceShell: Shell = {
      exec: async (command) => (command.includes('serve') ? serving.promise : { stdout: `ran ${command}\n`, stderr: '', exitCode: 0 }),
    };

    const shellSession = createShellSession({ home: WORKSPACE_ROOT, userRoots: () => [], keepsCwd: true, stored: async () => WORKSPACE_ROOT });
    const { rt } = createTestRuntime();
    const shell = withApprovalGatedShell(workspaceShell, { filesOwner: 'agent', shellSession });

    const wrapped = wrapToolsForBackground(
      buildBuiltinTools({ rt: { ...rt, shell }, conversations: conversationsFor(rt) }),
      { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
    );

    const run = toolExecute<{ command: string }, object | string>(present(wrapped.shell, 'the wrapped shell tool'));

    const detached = await run({ command: 'cd /tmp/site && serve' });
    expect(isBackgroundHandle(detached)).toBe(true);

    // A handle here is the next command outrunning the window behind the first.
    expect(await run({ command: 'echo next' })).toEqual(expect.stringContaining('ran echo next'));

    serving.resolve({ stdout: 'stopped\n', stderr: '', exitCode: 0 });
    await Promise.all(bodies);
    expect(store.get(isBackgroundHandle(detached) ? detached.jobId : '')?.result).toContain('stopped');
    expect((await shellSession.at()).cwd).toBe(WORKSPACE_ROOT);
  });
});

/** The port the agent exposed. */
const SERVED = 8001;

describe('a sandbox command a job takes', () => {
  // eval-site-preview-1-2ypddc, staging f75f06932, 2026-10-01: `node server.js` in the sandbox outran the window and
  // its job read as running forever, though all it did was serve the port the agent then exposed. The command carries
  // its job's id, so the sandbox's listener read can name the job that serves a port.
  test("carries the id of the job it became in its environment", async () => {
    const { runner, store, bodies } = wholeChainRunner();
    const serving = Promise.withResolvers<{ stdout: string; exitCode: number }>();
    const environments: Array<Record<string, string> | undefined> = [];

    const handle: SandboxHandle = {
      exec: (_command, opts) => {
        environments.push(opts?.env);

        return serving.promise;
      },
      readFile: async () => ({}),
      writeFile: async () => {},
      listFiles: async () => ({ files: [] }),
      deleteFile: async () => {},
      exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
      unexposePort: async () => {},
      getExposedPorts: async () => [],
      ...sandboxHandleLifecycle,
    };

    const router = new DefaultExecutionRouter();
    router.register(createSandboxExecutor(handle, 'preview.example.com'));
    const { rt } = createTestRuntime();

    const wrapped = wrapToolsForBackground(
      buildBuiltinTools({ rt: { ...rt, executionRouter: router }, conversations: conversationsFor(rt) }),
      { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
    );

    const run = toolExecute<{ command: string; runtime: string; why: string }, object | string>(present(wrapped.shell, 'the wrapped shell tool'));
    const detached = await run({ command: 'node server.js', runtime: 'sandbox', why: 'serve the site' });

    if (!isBackgroundHandle(detached)) throw new Error(`the server call did not detach: ${JSON.stringify(detached)}`);
    expect(environments).toEqual([{ [JOB_STAMP_ENV]: detached.jobId }]);
    expect(store.get(detached.jobId)?.status).toBe('running');

    serving.resolve({ stdout: 'stopped\n', exitCode: 0 });
    await Promise.all(bodies);
  });

  // The listing reads a record the job's own moments write (029e6cc1b): its detach and its settle. The real 30 s
  // window is crossed on a hand clock, not waited out.
  test('is recorded serving the exposed port it holds when it detaches, and no longer once it settles', async () => {
    const clock = handClock(Date.now());
    const serving = Promise.withResolvers<{ stdout: string; exitCode: number }>();
    let stamp: string | null = null;
    let listening = true;

    // The sandbox's exposed port, held by the command that carried `stamp` while it listens.
    const sandbox: PortHolders = {
      exposedPorts: async () => [SERVED],
      holders: async (ports) => (listening && ports.includes(SERVED) ? [{ port: SERVED, stamp }] : []),
    };

    const settledRecords: Array<Promise<void>> = [];

    const { runner, store, bodies } = wholeChainRunner((jobs) => ({
      clock,
      policy: () => BACKGROUND_POLICY.interactive,
      // As the cf actor wires them: the detach waits on its record, the settle starts one.
      onDetached: () => recordServingJobs(jobs, sandbox),
      onSettled: () => { settledRecords.push(recordServingJobs(jobs, sandbox)); },
    }));

    const handle: SandboxHandle = {
      // The server runs past its call's window: the window's time passes while it runs.
      exec: (_command, opts) => {
        stamp = opts?.env?.[JOB_STAMP_ENV] ?? null;
        clock.advance(BACKGROUND_POLICY.interactive.detachAfterMs);

        return serving.promise;
      },
      readFile: async () => ({}),
      writeFile: async () => {},
      listFiles: async () => ({ files: [] }),
      deleteFile: async () => {},
      exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
      unexposePort: async () => {},
      getExposedPorts: async () => [],
      ...sandboxHandleLifecycle,
    };

    const router = new DefaultExecutionRouter();
    router.register(createSandboxExecutor(handle, 'preview.example.com'));
    const { rt } = createTestRuntime();

    const wrapped = wrapToolsForBackground(
      buildBuiltinTools({ rt: { ...rt, executionRouter: router }, conversations: conversationsFor(rt) }),
      { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
    );

    const run = toolExecute<{ command: string; runtime: string; why: string }, object | string>(present(wrapped.shell, 'the wrapped shell tool'));
    const detached = await run({ command: 'node server.js', runtime: 'sandbox', why: 'serve the site' });

    if (!isBackgroundHandle(detached)) throw new Error(`the server call did not detach: ${JSON.stringify(detached)}`);
    expect(listBackgroundJobs(store).map(({ id, status }) => ({ id, status }))).toEqual([{ id: detached.jobId, status: 'serving' }]);

    // The server stops: its job settles, and nothing holds the port.
    listening = false;
    serving.resolve({ stdout: 'stopped\n', exitCode: 0 });
    await Promise.all(bodies);
    await Promise.all(settledRecords);

    expect(store.get(detached.jobId)).toMatchObject({ status: 'completed', serves: null });
  });
});

/** Every row any write on `db` changed since it opened. */
function rowsChanged(db: Database): number {
  return v.parse(v.object({ n: v.number() }), db.query('SELECT total_changes() AS n').get()).n;
}

const joined = (chunks: readonly OutputChunk[]): string => chunks.map(({ text }) => text).join('');

/** The whole chain on `clock`, its jobs' frames recorded, and how many had gone out at each settle. */
function recordingRunner(clock: ReturnType<typeof handClock>) {
  const frames: JobOutputFrame[] = [];
  const framesAtSettle: number[] = [];

  const chain = wholeChainRunner(() => ({
    clock,
    policy: () => BACKGROUND_POLICY.interactive,
    jobOutput: (frame) => { frames.push(frame); },
    onSettled: () => { framesAtSettle.push(frames.length); },
  }));

  return { ...chain, frames, framesAtSettle };
}

/** A sandbox build detached into a job on `clock`: the sink its command prints to, the job's frames, and its end. */
async function detachedBuild(clock: ReturnType<typeof handClock>) {
  const finished = Promise.withResolvers<{ stdout: string; exitCode: number }>();
  let given: OutputSink | undefined;
  const chain = recordingRunner(clock);

  const handle: SandboxHandle = {
    // The build prints, then outruns its call's window.
    exec: (_command, opts) => {
      given = opts?.output;
      given?.write('stdout', 'resolving dependencies\n');
      clock.advance(BACKGROUND_POLICY.interactive.detachAfterMs);

      return finished.promise;
    },
    readFile: async () => ({}),
    writeFile: async () => {},
    listFiles: async () => ({ files: [] }),
    deleteFile: async () => {},
    exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
    unexposePort: async () => {},
    getExposedPorts: async () => [],
    ...sandboxHandleLifecycle,
  };

  const router = new DefaultExecutionRouter();
  router.register(createSandboxExecutor(handle, 'preview.example.com'));
  const { rt } = createTestRuntime();

  const wrapped = wrapToolsForBackground(
    buildBuiltinTools({ rt: { ...rt, executionRouter: router }, conversations: conversationsFor(rt) }),
    { jobRunner: chain.runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
  );

  const run = toolExecute<{ command: string; runtime: string; why: string }, object | string>(present(wrapped.shell, 'the wrapped shell tool'));
  const detached = await run({ command: 'bun run build', runtime: 'sandbox', why: 'build the site' });

  if (!isBackgroundHandle(detached)) throw new Error(`the build did not detach: ${JSON.stringify(detached)}`);

  return {
    ...chain,
    jobId: detached.jobId,
    output: present(given, 'the sink the sandbox command was given'),
    finish: async () => {
      finished.resolve({ stdout: 'built\n', exitCode: 0 });
      await Promise.all(chain.bodies);
    },
  };
}

describe("a running job's output", () => {
  test('a window its output overflows drops the oldest and counts the drop in bytes, where it was', async () => {
    const clock = handClock(Date.now());
    const build = await detachedBuild(clock);

    // Five two-byte characters past what one window holds: the oldest five go, ten bytes.
    build.output.write('stdout', 'é'.repeat(WINDOW_CHARS));
    build.output.write('stdout', 'done\n');
    clock.advance(250);

    expect(build.frames.at(-1)).toEqual({
      type: JOB_OUTPUT_EVENT, jobId: build.jobId, seq: 2,
      chunks: [{ stream: 'stdout', text: `${'é'.repeat(WINDOW_CHARS - 5)}done\n`, omitted: 10 }], dropped: 10,
    });
    // The tail sheds the first frame's line to stay within its bound: 23 more bytes before what it keeps.
    const [listed] = listBackgroundJobs(build.store, 20, (id) => build.runner.output.tail(id));
    expect(listed?.output).toMatchObject({ seq: 2, omitted: 33, chunks: [{ omitted: 33 }] });
    expect(joined(present(listed?.output, "the running job's listed output").chunks).length).toBe(TAIL_CHARS);
    await build.finish();
  });

  test('a window cut inside a four-byte character drops the whole character and counts its four bytes', async () => {
    const clock = handClock(Date.now());
    const build = await detachedBuild(clock);
    const grin = String.fromCodePoint(0x1f600);

    // Two UTF-16 units each: one unit past the window, so the cut lands inside the oldest one.
    build.output.write('stdout', `${grin.repeat(WINDOW_CHARS / 2)}x`);
    clock.advance(250);

    expect(build.frames.at(-1)).toEqual({
      type: JOB_OUTPUT_EVENT, jobId: build.jobId, seq: 2,
      chunks: [{ stream: 'stdout', text: `${grin.repeat(WINDOW_CHARS / 2 - 1)}x`, omitted: 4 }], dropped: 4,
    });
    await build.finish();
  });

  test('a tail cut inside a four-byte character drops the whole character and counts its four bytes', () => {
    const grin = String.fromCodePoint(0x1f600);

    const frame: JobOutputFrame = {
      type: JOB_OUTPUT_EVENT, jobId: 'bgjob-grin', seq: 1, chunks: [{ stream: 'stdout', text: `${grin.repeat(TAIL_CHARS / 2)}x` }], dropped: 0,
    };

    expect(followJobOutput(undefined, frame)).toEqual({
      seq: 1, chunks: [{ stream: 'stdout', text: `${grin.repeat(TAIL_CHARS / 2 - 1)}x`, omitted: 4 }], omitted: 4,
    });
  });

  test("a loss the command's sink reports is marked between the lines around it", async () => {
    const clock = handClock(Date.now());
    const build = await detachedBuild(clock);

    build.output.write('stdout', 'one\n');
    build.output.lost(4096);
    build.output.write('stdout', 'two\n');
    clock.advance(250);

    expect(build.frames.at(-1)).toEqual({
      type: JOB_OUTPUT_EVENT, jobId: build.jobId, seq: 2,
      chunks: [{ stream: 'stdout', text: 'one\n' }, { stream: 'stdout', text: 'two\n', omitted: 4096 }], dropped: 4096,
    });

    // A loss with nothing printed after it yet is marked at the end, not held back.
    build.output.lost(512);
    clock.advance(250);
    expect(build.frames.at(-1)).toMatchObject({ seq: 3, chunks: [{ text: '', omitted: 512 }], dropped: 512 });
    await build.finish();
  });

  // Main's queue, 2026-10-02: a job's output reached no one until it settled, so a long build showed nothing in the UI
  // or TUI until it finished. It goes to the job's rooms a window at a time, and is never a row.
  test('reaches its rooms while it runs, a window at a time, and its settle comes after its last frame', async () => {
    const clock = handClock(Date.now());
    const { runner, store, db, frames, framesAtSettle, jobId, output, finish } = await detachedBuild(clock);

    // The job's first frame, at its detach, holds what the build printed before the job took it.
    expect(frames).toEqual([{ type: JOB_OUTPUT_EVENT, jobId, seq: 1, chunks: [{ stream: 'stdout', text: 'resolving dependencies\n' }], dropped: 0 }]);
    const rowsAtDetach = rowsChanged(db);

    // A character split across two writes arrives whole.
    output.write('stderr', Uint8Array.of(0x77, 0x61, 0x72, 0x6e, 0x3a, 0x20, 0x63, 0x61, 0x66, 0xc3));
    output.write('stderr', Uint8Array.of(0xa9, 0x0a));
    clock.advance(250);
    expect(frames.at(-1)).toEqual({ type: JOB_OUTPUT_EVENT, jobId, seq: 2, chunks: [{ stream: 'stderr', text: 'warn: café\n' }], dropped: 0 });

    // Ten thousand lines in one second, a hundred every ten milliseconds: a frame per quarter second.
    for (let line = 0; line < 10_000; line += 1) {
      output.write('stdout', `compiled module ${String(line)}\n`);

      if (line % 100 === 99) clock.advance(10);
    }

    const flood = frames.slice(2);
    expect(flood.map(({ seq }) => seq)).toEqual([3, 4, 5, 6]);

    // Each holds its window's newest characters and says how many bytes it left out.
    for (const frame of flood) expect(joined(frame.chunks).length).toBeLessThanOrEqual(WINDOW_CHARS);
    expect(flood.every(({ dropped }) => dropped > 0)).toBe(true);
    expect(joined(present(flood.at(-1), 'the last flood frame').chunks).endsWith('compiled module 9999\n')).toBe(true);

    // A page that opens now reads the tail those frames carried, through the last of them.
    const [listed] = listBackgroundJobs(store, 20, (id) => runner.output.tail(id));
    const tail = present(listed?.output, "the running job's listed output");
    expect(tail.seq).toBe(6);
    expect(joined(tail.chunks).endsWith('compiled module 9999\n')).toBe(true);
    expect(joined(tail.chunks).length).toBeLessThanOrEqual(TAIL_CHARS);
    // The same tail a client holds that followed every frame from the first.
    expect(frames.reduce<JobOutputTail | undefined>((told, frame) => followJobOutput(told, frame), undefined)).toEqual(tail);

    // None of it was a row.
    expect(rowsChanged(db)).toBe(rowsAtDetach);

    // The build ends: what it printed last goes out before its settle, and the job holds no output after it.
    output.write('stdout', 'built in 41s\n');
    await finish();

    expect(frames.at(-1)).toEqual({ type: JOB_OUTPUT_EVENT, jobId, seq: 7, chunks: [{ stream: 'stdout', text: 'built in 41s\n' }], dropped: 0 });
    expect(framesAtSettle).toEqual([7]);
    expect(store.get(jobId)?.status).toBe('completed');
    expect(runner.output.tail(jobId)).toBeUndefined();
  });

  test("a device command's output reaches its job's rooms while it runs, as the hub hands over the machine's frames", async () => {
    const clock = handClock(Date.now());
    const answered = Promise.withResolvers<string>();
    const base64 = (text: string): string => Buffer.from(text).toString('base64');
    let handedOver: ((output: DeviceExecOutput) => void) | undefined;
    const { runner, store, bodies, frames, framesAtSettle } = recordingRunner(clock);

    // As UserDO hands over the daemon's frames: the build prints, then outruns its call's window.
    const hub: DeviceHubClient = {
      deviceRuntimeStatus: async () => ({ connected: true, registered: true, toolchain: null }),
      deviceRpc: async (_caller, _method, _params, opts) => {
        handedOver = opts?.onOutput;
        handedOver?.({ chunks: [{ stream: 'stdout', data: base64('resolving dependencies\n') }], dropped: 0 });
        clock.advance(BACKGROUND_POLICY.interactive.detachAfterMs);

        return answered.promise;
      },
      acknowledgeDeviceRequest: async () => {},
    };

    const transport = createHubDeviceTransport({ hub: () => hub, caller: async () => ({ workspaceToken: 'pwc_test' }), agentName: 'main', cliCwd: () => null });
    await transport.refreshStatus();
    const router = new DefaultExecutionRouter();
    router.register(createDeviceTunnelExecutor(transport));
    const { rt } = createTestRuntime();

    const wrapped = wrapToolsForBackground(
      buildBuiltinTools({ rt: { ...rt, executionRouter: router, deviceTransport: transport }, conversations: conversationsFor(rt) }),
      { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
    );

    const run = toolExecute<{ command: string; runtime: string; why: string }, object | string>(present(wrapped.shell, 'the wrapped shell tool'));
    const detached = await run({ command: 'bun run build', runtime: 'device', why: 'build on their machine' });

    if (!isBackgroundHandle(detached)) throw new Error(`the build did not detach: ${JSON.stringify(detached)}`);
    const { jobId } = detached;
    const machine = present(handedOver, "the callback the hub was handed for the machine's frames");

    expect(frames).toEqual([{ type: JOB_OUTPUT_EVENT, jobId, seq: 1, chunks: [{ stream: 'stdout', text: 'resolving dependencies\n' }], dropped: 0 }]);

    // A window the machine could not send whole: its bytes, and what it left out.
    machine({ chunks: [{ stream: 'stderr', data: base64('warn: café\n') }], dropped: 2048 });
    clock.advance(250);
    expect(frames.at(-1)).toEqual({ type: JOB_OUTPUT_EVENT, jobId, seq: 2, chunks: [{ stream: 'stderr', text: 'warn: café\n', omitted: 2048 }], dropped: 2048 });

    machine({ chunks: [{ stream: 'stdout', data: base64('built in 41s\n') }], dropped: 0 });
    answered.resolve(JSON.stringify({ stdout: 'resolving dependencies\nbuilt in 41s\n', stderr: 'warn: café\n', exitCode: 0 }));
    await Promise.all(bodies);

    expect(frames.at(-1)).toEqual({ type: JOB_OUTPUT_EVENT, jobId, seq: 3, chunks: [{ stream: 'stdout', text: 'built in 41s\n' }], dropped: 0 });
    expect(framesAtSettle).toEqual([3]);
    expect(store.get(jobId)?.status).toBe('completed');
  });

  test('a call that ends inside its window sends nothing: only a job has rooms to show it', async () => {
    const frames: JobOutputFrame[] = [];
    const { runner, bodies } = wholeChainRunner(() => ({ policy: () => BACKGROUND_POLICY.interactive, jobOutput: (frame) => { frames.push(frame); } }));

    const handle: SandboxHandle = {
      exec: async (_command, opts) => {
        opts?.output?.write('stdout', 'ok\n');

        return { stdout: 'ok\n', exitCode: 0 };
      },
      readFile: async () => ({}),
      writeFile: async () => {},
      listFiles: async () => ({ files: [] }),
      deleteFile: async () => {},
      exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
      unexposePort: async () => {},
      getExposedPorts: async () => [],
      ...sandboxHandleLifecycle,
    };

    const router = new DefaultExecutionRouter();
    router.register(createSandboxExecutor(handle, 'preview.example.com'));
    const { rt } = createTestRuntime();

    const wrapped = wrapToolsForBackground(
      buildBuiltinTools({ rt: { ...rt, executionRouter: router }, conversations: conversationsFor(rt) }),
      { jobRunner: runner, mode: () => 'build', backgroundable: BACKGROUNDABLE_TOOLS },
    );

    const run = toolExecute<{ command: string; runtime: string; why: string }, object | string>(present(wrapped.shell, 'the wrapped shell tool'));
    expect(await run({ command: 'echo ok', runtime: 'sandbox', why: 'check' })).toContain('ok');
    await Promise.all(bodies);

    expect(frames).toEqual([]);
  });
});
