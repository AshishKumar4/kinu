// Untimed work ends only on completion or cancellation. An explicit deadline also kills the
// native process before reporting cancellation; codemode has no implicit work deadline.
import { describe, test, expect } from "bun:test";
import { createSandboxExecutor } from "@kinu.run/core";
import type { KinuDevbox } from "../src/kinu-devbox";
import { adaptCloudflareSandbox } from "../src/sandbox-exec-lane";
import { execRecords } from "@kinu.run/devbox";
// codemode reaches `cloudflare:workers` at load; the preload's boundary stub serves it.
import { CodemodeLauncher, createRuntimeExecutor, KinuSandboxExecutor } from "../src/codemode-sandbox";
import { workerContext } from "./helpers/bindings";
import { inProcessWorkerLoader } from "./helpers/worker-loader";

interface BoxCalls {
  started: Array<{ command: string; cwd?: string }>;
  killed: string[];
  streamed: string[];
}

/**
 * `holdsUntilKilled`: only the kill ends the command, so a cancellation reported before `exited` flips is
 * observable. `finishesFirst`: the command has already exited when the kill arrives.
 */
function fakeBox(input: {
  exitCode?: number;
  holdsUntilKilled?: boolean;
  finishesFirst?: boolean;
  killFails?: boolean;
  /** What `execUntimedStream` answers: the box's record stream for the command. */
  streamed?: () => ReadableStream<Uint8Array>;
} = {}) {
  const calls: BoxCalls = { started: [], killed: [], streamed: [] };
  const held = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
  let exited = false;

  const box = {
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    execUntimed: async (command: string, opts: { cwd?: string; execId: string }) => {
      const call: BoxCalls["started"][number] = { command };

      if (opts.cwd !== undefined) call.cwd = opts.cwd;
      calls.started.push(call);

      if (input.holdsUntilKilled === true) return await held.promise;
      exited = true;

      return { stdout: "epoch 40/40 done\n", stderr: "", exitCode: input.exitCode ?? 0 };
    },
    execUntimedStream: async (command: string) => {
      calls.streamed.push(command);

      if (input.streamed === undefined) throw new Error('this box streams nothing');

      return input.streamed();
    },
    killUntimed: async (execId: string) => {
      calls.killed.push(execId);

      if (input.killFails === true) throw new Error(`the container refused to end process 41: ${execId}`);

      if (input.finishesFirst === true) {
        held.resolve({ stdout: "done before the kill\n", stderr: "", exitCode: 0 });

        return false;
      }

      exited = true;
      held.resolve({ stdout: "", stderr: "", exitCode: 143 });

      return true;
    },
    readFile: async () => ({ content: "" }),
    writeFile: async () => undefined,
    listFiles: async () => ({ files: [] }),
    deleteFile: async () => undefined,
    exposePort: async (port: number) => ({ url: `https://p/${port}`, port }),
    unexposePort: async () => undefined,
    getExposedPorts: async () => [],
    startSupervised: async () => ({ processId: "sup-1" }),
    stopSupervised: async () => ({ stopped: true }),
    listSupervised: async () => [],
    portToken: async (port: number) => ({ urlToken: `tok-${port}` }),
    notePortExposed: async () => {},
    notePortRemoved: async () => undefined,
  };

  // `KinuDevbox` is a DO class a test cannot construct; only the members above are reachable.
  const sdk: KinuDevbox = Object.create(box);

  // No-op egress preflight: tested in unit-egress-interception.test.ts.
  return {
    calls,
    /** The only evidence a cancellation may be reported on. */
    hasExited: () => exited,
    // `null`: this box exposes no ports, so the lane mints no preview URL.
    handle: adaptCloudflareSandbox(sdk, async () => {}, null),
  };
}

const TRAINING = "python3 train.py --epochs 40 2>&1 | tee /workspace/train.log";

describe("adaptCloudflareSandbox — command completion", () => {
  test("an explicit deadline ends the process before reporting cancellation", async () => {
    const box = fakeBox({ holdsUntilKilled: true });
    await expect(box.handle.exec("work until cancelled", { timeout: 1 })).rejects.toMatchObject({ code: 'cancelled' });
    expect(box.hasExited()).toBe(true);
  });

  test("a non-zero exit is reported as itself, not as a transport failure", async () => {
    const box = fakeBox({ exitCode: 137 });

    expect((await box.handle.exec("bash oom.sh", {})).exitCode).toBe(137);
  });

});

const encoder = new TextEncoder();

/** A pipe that gives `chunks` in order, then ends. */
function pipe(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

// 2026-10-02: a sandbox job's output reached no one until its command ended.
describe("adaptCloudflareSandbox — a command shown as it is printed", () => {
  test("hands each chunk to the call's sink as the box streams it, and answers what the plain exec would", async () => {
    const process = { stdout: pipe("compiled 1\n", "built\n"), stderr: pipe("warn: chunk size\n"), exitCode: Promise.resolve(2) };
    const box = fakeBox({ streamed: () => execRecords(process, { exited: () => {}, cancelled: async () => {} }) });
    const heard: string[] = [];
    const decoder = new TextDecoder();
    const output = { write: (stream: string, data: Uint8Array | string) => { heard.push(`${stream}: ${data instanceof Uint8Array ? decoder.decode(data) : data}`); }, lost: () => {} };

    const result = await box.handle.exec("bun run build", { output });

    expect(result).toEqual({ stdout: "compiled 1\nbuilt\n", stderr: "warn: chunk size\n", exitCode: 2 });
    expect(heard.filter((line) => line.startsWith("stdout"))).toEqual(["stdout: compiled 1\n", "stdout: built\n"]);
    expect(heard.filter((line) => line.startsWith("stderr"))).toEqual(["stderr: warn: chunk size\n"]);
    expect(box.calls).toMatchObject({ streamed: ["bun run build"], started: [] });
  });

  test("a stream that ends without its exit code fails the command as io, not as a finished one", async () => {
    // One stdout record, `hi\n`, and then the stream ends.
    const cut = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1, 0, 0, 0, 3, 104, 105, 10)); controller.close(); } });
    const box = fakeBox({ streamed: () => cut });

    await expect(box.handle.exec("bun run build", { output: { write: () => {}, lost: () => {} } }))
      .rejects.toMatchObject({ code: 'io', message: expect.stringContaining('ended without its exit code') });
  });
});

describe("adaptCloudflareSandbox — a pending readiness refuses before dispatch", () => {
  test("a box still restoring answers `unavailable` and the command never exists", async () => {
    // `pending` arrives as data (survives DO RPC) and is refused before `run()` as `error.code`.
    const reason = 'this devbox has no attached work directory: stale owner, retry armed. '
      + 'A retry is already under way; operations are refused until it lands.';
 
    const calls: BoxCalls = { started: [], killed: [], streamed: [] };

    const box: KinuDevbox = Object.create({
      resolveReadiness: async () => ({ kind: 'pending' as const, reason }),
      execUntimed: async (command: string) => { calls.started.push({ command }); },
    });

    const handle = adaptCloudflareSandbox(box, async () => {}, null);

    await expect(handle.exec("bun test")).rejects.toMatchObject({
      name: 'KinuError[unavailable]', code: 'unavailable', message: reason,
    });
    expect(calls).toEqual({ started: [], killed: [], streamed: [] });

    // The refusal is the pending kind, not a blanket gate failure.
    const ready: KinuDevbox = Object.create({
      resolveReadiness: async () => ({ kind: 'restored' as const }),
      execUntimed: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    });
 
    await expect(adaptCloudflareSandbox(ready, async () => {}, null)
      .exec("bun test", { timeout: 5_000 })).resolves.toMatchObject({ exitCode: 0 });
  });
});

// KINU-033. An abort must kill the process, not just end the wait: an unwatched build keeps
// writing to /workspace otherwise.
describe("adaptCloudflareSandbox — cancellation reaches the process", () => {
  test("an abort kills THAT process and reports only once it is gone", async () => {
    const box = fakeBox({ holdsUntilKilled: true });
    const controller = new AbortController();

    const pending = box.handle.exec("bash forever.sh", { signal: controller.signal });
    // Only the kill ends this process, so a report without one is over live work.
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(box.calls.killed).toHaveLength(1);
    expect(box.hasExited()).toBe(true);
  });

  test("a signal already aborted kills the process it just started", async () => {
    const box = fakeBox({ holdsUntilKilled: true });
    const controller = new AbortController();
    controller.abort();

    await expect(box.handle.exec("bash forever.sh", { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(box.calls.killed).toHaveLength(1);
  });

  // Review 3f6, 2026-09-30: the adapter's cancellation reached the executor as `KinuError[cancelled]`,
  // which it did not recognise, so an aborted exec came back as an ordinary tool result.
  test("the sandbox executor rejects an aborted exec as a cancellation, not as a tool result", async () => {
    const box = fakeBox({ holdsUntilKilled: true });
    const executor = createSandboxExecutor(box.handle);
    const controller = new AbortController();

    const pending = executor.tools.exec.execute("bash forever.sh", { signal: controller.signal });
    controller.abort();
    const [settled] = await Promise.allSettled([pending]);

    expect(settled).toEqual({ status: 'rejected', reason: expect.objectContaining({ code: 'cancelled' }) });
    expect({ killed: box.calls.killed.length, exited: box.hasExited() }).toEqual({ killed: 1, exited: true });
  });

  test("a kill that FAILS is reported as itself, never as a cancellation", async () => {
    // The container refused, so the process is still there; `cancelled` would be a lie.
    const box = fakeBox({ holdsUntilKilled: true, killFails: true });
    const controller = new AbortController();

    const pending = box.handle.exec("bash forever.sh", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/refused to end process 41/);
    expect(box.hasExited()).toBe(false);
  });

  test("a command that finished before the kill reached it is returned as finished", async () => {
    const box = fakeBox({ holdsUntilKilled: true, finishesFirst: true });
    const controller = new AbortController();

    const pending = box.handle.exec("bash short.sh", { signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ exitCode: 0, stdout: "done before the kill\n" });
  });

  test("no signal, no kill", async () => {
    const box = fakeBox();

    await box.handle.exec(TRAINING, { cwd: "/workspace" });

    expect(box.calls.killed).toEqual([]);
  });
});

// KINU-034 is enforced in the container object: packages/devbox/tests/resource-lane.test.ts.

/** A timer source a test moves by hand: `advance` fires every timer then due, in order. */
function workerClock() {
  let now = 0;
  const pending: Array<{ readonly at: number; readonly fire: () => void }> = [];
  const armed = Promise.withResolvers<void>();

  return {
    /** Settles once the program has armed a timer, so it is running. */
    armed: armed.promise,
    setTimeout: (fire: () => void, ms: number): void => {
      pending.push({ at: now + ms, fire });
      armed.resolve();
    },
    advance: (ms: number): void => {
      now += ms;

      for (const due of pending.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)) {
        pending.splice(pending.indexOf(due), 1);
        due.fire();
      }
    },
  };
}

type RunProgram = (code: string, providers: Array<{ name: string; fns: Record<string, () => Promise<string>> }>) => Promise<object>;

/** A program that awaits one host call, which answers only after a minute of the isolate's time has passed. */
async function reportAfterAMinute(build: (loader: WorkerLoader) => RunProgram): Promise<object> {
  const clock = workerClock();
  const report = Promise.withResolvers<string>();
  // `WorkerLoader` is a workerd binding with no constructible form; codemode reaches only `load`.
  const loader: WorkerLoader = Object.create(inProcessWorkerLoader(clock));
  const run = build(loader)("async () => await agent.report()", [{ name: "agent", fns: { report: async () => report.promise } }]);

  await clock.armed;
  clock.advance(61_000);
  report.resolve("banana");

  return run;
}

// 2026-09-24, the first-run tier on 24ea8520b: all five swarm nodes died together, "errored after 0 step(s) in
// 60157 ms: run agent <id> to a report: Execution timed out". codemode races each program against its `timeout`
// (default 60 s), and a node agent's whole scaffold loop runs as one program through `rt.executor`.
function launcherOver(loader: WorkerLoader, kinuNode: boolean): CodemodeLauncher {
  return new CodemodeLauncher({ ...workerContext(), props: { kinuNode, egress: null } }, { LOADER: loader });
}

describe("a program awaiting a host call past a minute still gets its answer", () => {
  test("in the runtime's executor, where a node agent's scaffold loop runs", async () => {
    expect(await reportAfterAMinute((loader) => (code, providers) => createRuntimeExecutor(launcherOver(loader, false)).execute(code, providers)))
      .toEqual({ result: "banana", logs: [] });
  });

  test("in the eval sandbox", async () => {
    expect(await reportAfterAMinute((loader) => (code, providers) => new KinuSandboxExecutor(launcherOver(loader, true)).execute(code, providers)))
      .toEqual({ result: "banana", logs: [] });
  });
});
