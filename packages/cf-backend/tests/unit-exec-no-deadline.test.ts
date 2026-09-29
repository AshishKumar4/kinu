// Defends: detached work killed by `Command timeout after 60000ms` (owner screenshot). The SDK's
// plain `exec` is bounded (`sandbox.exec.request_ceiling_ms`), so untimed exec takes the runtime's own exec;
// codemode's default deadline killed `eval` programs awaiting long host tool calls.
import { describe, test, expect } from "bun:test";
import type { KinuSandbox } from "../src/kinu-sandbox";
import { adaptCloudflareSandbox } from "../src/sandbox-exec-lane";
// codemode reaches `cloudflare:workers` at load; the preload's boundary stub serves it.
import { CodemodeLauncher, createRuntimeExecutor, KinuSandboxExecutor } from "../src/codemode-sandbox";
import { workerContext } from "./helpers/bindings";
import { inProcessWorkerLoader } from "./helpers/worker-loader";

interface BoxCalls {
  exec: Array<{ command: string; timeout?: number }>;
  started: Array<{ command: string; cwd?: string }>;
  killed: string[];
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
} = {}) {
  const calls: BoxCalls = { exec: [], started: [], killed: [] };
  const held = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
  let exited = false;

  const box = {
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    exec: async (command: string, opts?: { timeout?: number }) => {
      const call: BoxCalls["exec"][number] = { command };

      if (opts?.timeout !== undefined) call.timeout = opts.timeout;
      calls.exec.push(call);

      return { stdout: "bounded", exitCode: 0 };
    },
    execUntimed: async (command: string, opts: { cwd?: string; execId: string }) => {
      const call: BoxCalls["started"][number] = { command };

      if (opts.cwd !== undefined) call.cwd = opts.cwd;
      calls.started.push(call);

      if (input.holdsUntilKilled === true) return await held.promise;
      exited = true;

      return { stdout: "epoch 40/40 done\n", stderr: "", exitCode: input.exitCode ?? 0 };
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

  // `KinuSandbox` is a DO class a test cannot construct; only the members above are reachable.
  const sdk: KinuSandbox = Object.create(box);

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

describe("adaptCloudflareSandbox — which lane a command gets", () => {
  test("no timeout asked for → the runtime's exec, and the SDK's bounded exec is untouched", async () => {
    const box = fakeBox();

    const res = await box.handle.exec(TRAINING, { cwd: "/workspace" });

    expect(box.calls.exec).toEqual([]);
    expect(box.calls.started).toEqual([{ command: TRAINING, cwd: "/workspace" }]);
    expect(res.stdout).toContain("epoch 40/40 done");
    expect(res.exitCode).toBe(0);
  });

  test("a caller that ASKED for a deadline still gets the bounded exec", async () => {
    const box = fakeBox();

    // Not git-shaped: that trips no-ambient-git-in-tests, which cannot see this is a fake.
    const res = await box.handle.exec("bun test --changed", { cwd: "/workspace", timeout: 5_000 });

    expect(box.calls.exec).toEqual([{ command: "bun test --changed", timeout: 5_000 }]);
    expect(box.calls.started).toEqual([]);
    expect(res.stdout).toBe("bounded");
  });

  test("a non-zero exit is reported as itself, not as a transport failure", async () => {
    const box = fakeBox({ exitCode: 137 });

    expect((await box.handle.exec("bash oom.sh", {})).exitCode).toBe(137);
  });

  test("the untimed lane defaults to the durable work directory", async () => {
    const box = fakeBox();

    await box.handle.exec("ls", {});

    expect(box.calls.started[0]?.cwd).toBe("/workspace");
  });
});

describe("adaptCloudflareSandbox — a pending readiness refuses before dispatch", () => {
  test("a box still restoring answers `unavailable` and the command never exists", async () => {
    // `pending` arrives as data (survives DO RPC) and is refused before `run()` as `error.code`.
    const reason = 'this devbox has no attached work directory: stale owner, retry armed. '
      + 'A retry is already under way; operations are refused until it lands.';
 
    const calls: BoxCalls = { exec: [], started: [], killed: [] };

    const box: KinuSandbox = Object.create({
      resolveReadiness: async () => ({ kind: 'pending' as const, reason }),
      exec: async (command: string) => { calls.exec.push({ command }); },
      startProcess: async (command: string) => { calls.started.push({ command }); },
    });

    const handle = adaptCloudflareSandbox(box, async () => {}, null);

    await expect(handle.exec("bun test")).rejects.toMatchObject({
      name: 'KinuError[unavailable]', code: 'unavailable', message: reason,
    });
    expect(calls).toEqual({ exec: [], started: [], killed: [] });

    // The refusal is the pending kind, not a blanket gate failure.
    const ready: KinuSandbox = Object.create({
      resolveReadiness: async () => ({ kind: 'restored' as const }),
      exec: async () => ({ stdout: 'ok', exitCode: 0 }),
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

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringContaining("its container process tree was ended"),
    });
    expect(box.calls.killed).toHaveLength(1);
    expect(box.hasExited()).toBe(true);
  });

  test("a signal already aborted kills the process it just started", async () => {
    const box = fakeBox({ holdsUntilKilled: true });
    const controller = new AbortController();
    controller.abort();

    await expect(box.handle.exec("bash forever.sh", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(box.calls.killed).toHaveLength(1);
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
    expect(await reportAfterAMinute((loader) => (code, providers) => new KinuSandboxExecutor({ launch: launcherOver(loader, true) }).execute(code, providers)))
      .toEqual({ result: "banana", logs: [] });
  });
});
