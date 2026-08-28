// The two Cloudflare-side ceilings that killed detached work, and the lanes that
// replace them.
//
// Production evidence (owner screenshot, workspace my-ai-engineer-b3b8b792): a
// tee'd training script through `run` at `runtime: 'sandbox'` returned
// `CommandError: … Command timeout after 60000ms`. Core no longer sends that
// number, but removing it is not enough on this SDK, and that is what these
// tests pin:
//
//   * The SDK's plain `exec` is bounded whether or not we ask. The container
//     enforces a command deadline, and the request carrying it rides the
//     non-streaming path whose own ceiling is 120s — the SDK's git client raises
//     `requestTimeoutMs` explicitly for a long clone rather than trusting that
//     default, which is the proof the ceiling is real. So `SandboxHandle.exec`
//     with no `timeout` must reach the PROCESS lane, not `exec`.
//   * `@cloudflare/codemode` gives a dynamic Worker a 60s execution deadline by
//     default, raced against the program as a generated `setTimeout`. An
//     `execute_tools` program spends its life AWAITING host tool calls, so that
//     deadline killed the caller of long work — after the 30s detach had already
//     told the model the work was "still running, not cancelled".
import { describe, test, expect, mock } from "bun:test";
import type { CraftedTool, CraftStore } from "@kinu.run/core";
import type { KinuSandbox } from "../src/kinu-sandbox";
import { initCraftQualityColumns, NO_TIMER_DEADLINE_MS } from "@kinu.run/core";
import { createTestSql } from "@kinu.run/test-utils";
import { adaptCloudflareSandbox } from "../src/sandbox-exec-lane";

// codemode reaches `cloudflare:workers` at load, so that specifier must be
// stubbed before its module is evaluated — hence the one dynamic import. The
// exec-lane adapter needs no stub at all, which is the point of it living
// outside `runtime.ts`.
// `mock.module` is process-wide, so this stub is what a SIBLING suite loaded in
// the same run also gets. It therefore has to carry every export the src graph
// binds, not just the ones this file needs: `tracing` is bound at load by
// cf-backend/src/obs/cf-tracer.ts, and omitting it turned a co-run with
// unit-preview-origin.test.ts into a load-time
// `SyntaxError: Export named 'tracing' not found`.
mock.module("cloudflare:workers", () => ({
  RpcTarget: class {}, WorkerEntrypoint: class {}, DurableObject: class {},
  tracing: {},
}));

const { PreambleCraftedExecutor } = await import("../src/crafted-tool-registry");

interface ProcessDouble {
  id: string;
  exitCode?: number;
  status: string;
  waitForExit: () => Promise<{ exitCode: number }>;
  getStatus: () => Promise<string>;
}

interface BoxCalls {
  exec: Array<{ command: string; timeout?: number }>;
  started: Array<{ command: string; cwd?: string }>;
  killed: string[];
}

/**
 * The SDK surface `adaptCloudflareSandbox` consumes, over the process lane.
 * `waitsBeforeExit` models the ONE thing that can interrupt the observation: the
 * process log stream idles out after 300s of silence while the process is still
 * perfectly alive. Each entry is one such interruption.
 *
 * `holdsUntilKilled` is the cancellation case: the command never finishes on its
 * own, so the only thing that can produce an exit code is the kill. That is what
 * makes the ORDER observable — a cancellation reported before `exited` flips
 * would be a cancellation reported over a live process.
 */
function fakeBox(input: {
  waitsBeforeExit?: number;
  exitCode?: number;
  holdsUntilKilled?: boolean;
  killFails?: boolean;
} = {}) {
  const calls: BoxCalls = { exec: [], started: [], killed: [] };
  let interruptions = input.waitsBeforeExit ?? 0;
  const held = Promise.withResolvers<{ exitCode: number }>();
  let exited = false;
  const proc: ProcessDouble = {
    id: "proc-1",
    status: "running",
    waitForExit: async () => {
      if (interruptions > 0) {
        interruptions -= 1;
        throw new Error("Stream idle timeout after 300000ms");
      }
      if (input.holdsUntilKilled === true) return await held.promise;
      return { exitCode: input.exitCode ?? 0 };
    },
    getStatus: async () => "running",
  };
  const box = {
    ensureReady: async () => {},
    exec: async (command: string, opts?: { timeout?: number }) => {
      const call: BoxCalls["exec"][number] = { command };
      if (opts?.timeout !== undefined) call.timeout = opts.timeout;
      calls.exec.push(call);
      return { stdout: "bounded", exitCode: 0 };
    },
    startProcess: async (command: string, opts?: { cwd?: string }) => {
      const call: BoxCalls["started"][number] = { command };
      if (opts?.cwd !== undefined) call.cwd = opts.cwd;
      calls.started.push(call);
      return proc;
    },
    getProcess: async () => proc,
    getProcessLogs: async () => ({ stdout: "epoch 40/40 done\n", stderr: "" }),
    killProcess: async (id: string) => {
      calls.killed.push(id);
      if (input.killFails === true) {
        throw new Error(`container refused to kill ${id}: no such process`);
      }
      exited = true;
      held.resolve({ exitCode: 137 });
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
  // Unchecked and named: `KinuSandbox` is a Durable Object class, so a test
  // cannot construct one. The double rides the prototype the way
  // helpers/jsrpc-stub.ts builds stubs — the adapter reaches only methods, and
  // exactly the members above are reachable, which is the boundary under test.
  const sdk: KinuSandbox = Object.create(box);
  // The egress preflight is a no-op here: which LANE a command takes is what
  // this file measures, and the preflight has its own suite
  // (unit-egress-interception.test.ts).
  return {
    calls,
    /** True once the process has an exit code, which is the only evidence a
     *  cancellation may be reported on. */
    hasExited: () => exited,
    handle: adaptCloudflareSandbox(sdk, async () => {}),
  };
}

const TRAINING = "python3 train.py --epochs 40 2>&1 | tee /workspace/train.log";

describe("adaptCloudflareSandbox — which lane a command gets", () => {
  test("no timeout asked for → the process lane, and the SDK's bounded exec is untouched", async () => {
    const box = fakeBox();

    const res = await box.handle.exec(TRAINING, { cwd: "/workspace" });

    expect(box.calls.exec).toEqual([]);
    expect(box.calls.started).toEqual([{ command: TRAINING, cwd: "/workspace" }]);
    expect(res.stdout).toContain("epoch 40/40 done");
    expect(res.exitCode).toBe(0);
  });

  test("a caller that ASKED for a deadline still gets the bounded exec", async () => {
    const box = fakeBox();

    // A neutral command: the property under test is the LANE (bounded exec vs
    // process), not the program. A git-shaped string here trips the
    // no-ambient-git-in-tests rule, whose matcher cannot see this is a fake.
    const res = await box.handle.exec("bun test --changed", { cwd: "/workspace", timeout: 5_000 });

    expect(box.calls.exec).toEqual([{ command: "bun test --changed", timeout: 5_000 }]);
    expect(box.calls.started).toEqual([]);
    expect(res.stdout).toBe("bounded");
  });

  test("a silent process outlives the log stream's idle window instead of failing", async () => {
    // Three idle-outs is ~15 minutes of silence. Nothing was killed, so the
    // adapter looks again; only the process's own exit ends the wait.
    const box = fakeBox({ waitsBeforeExit: 3, exitCode: 0 });

    const res = await box.handle.exec("bash quiet-build.sh", { cwd: "/workspace" });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("epoch 40/40 done");
    expect(box.calls.started).toHaveLength(1);
  });

  test("a non-zero exit is reported as itself, not as a transport failure", async () => {
    const box = fakeBox({ exitCode: 137 });

    expect((await box.handle.exec("bash oom.sh", {})).exitCode).toBe(137);
  });

  test("the process lane defaults to the durable work directory", async () => {
    const box = fakeBox();

    await box.handle.exec("ls", {});

    expect(box.calls.started[0]?.cwd).toBe("/workspace");
  });
});

// KINU-033. An abort used to stop the WAIT and nothing else: core raced the
// signal, returned, and told the agent the command "may still finish inside the
// container" — a turn moving on while an unwatched build kept writing to
// /workspace. The process lane has an id, and an id has a kill.
describe("adaptCloudflareSandbox — cancellation reaches the process", () => {
  test("an abort kills THAT process and reports only once it is gone", async () => {
    const box = fakeBox({ holdsUntilKilled: true });
    const controller = new AbortController();

    const pending = box.handle.exec("bash forever.sh", { signal: controller.signal });
    // The kill is what ends this process, so a report that arrives without one
    // is a report over live work.
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: expect.stringContaining("container process proc-1 was killed"),
    });
    expect(box.calls.killed).toEqual(["proc-1"]);
    expect(box.hasExited()).toBe(true);
  });

  test("a signal already aborted kills the process it just started", async () => {
    const box = fakeBox({ holdsUntilKilled: true });
    const controller = new AbortController();
    controller.abort();

    await expect(box.handle.exec("bash forever.sh", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(box.calls.killed).toEqual(["proc-1"]);
  });

  test("a kill that FAILS is reported as itself, never as a cancellation", async () => {
    // The container refused, so the process is still there. Reporting
    // `cancelled` over it is the exact defect this replaced.
    const box = fakeBox({ holdsUntilKilled: true, killFails: true });
    const controller = new AbortController();

    const pending = box.handle.exec("bash forever.sh", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/refused to kill proc-1/);
    expect(box.hasExited()).toBe(false);
  });

  test("no signal, no kill", async () => {
    const box = fakeBox();

    await box.handle.exec(TRAINING, { cwd: "/workspace" });

    expect(box.calls.killed).toEqual([]);
  });
});

// KINU-034 is NOT tested here any more, and that is the finding's answer rather
// than a gap. The adapter used to hold a keyed queue and this file used to prove
// it; the queue ordered one facet's calls while every facet of a workspace has
// its own copy of this adapter and they all address the same container. The claim
// moved into the object all of them reach, and its tests moved with it:
// packages/devbox/tests/resource-lane.test.ts.

function emptyCraftStore(): CraftStore {
  const rows: CraftedTool[] = [];
  const unsupported = (): never => { throw new Error("unused CraftStore operation"); };
  return {
    create: unsupported, update: unsupported, get: () => undefined, delete: unsupported,
    list: () => rows, search: () => [], getAll: () => rows,
  };
}

describe("the codemode program carries no execution deadline of its own", () => {
  test("the generated dynamic Worker gets no 60s kill", async () => {
    const { db, sql } = createTestSql();
    initCraftQualityColumns((ddl: string) => db.exec(ddl), sql);
    let generated = "";
    // The real generated program is the evidence: codemode races it against a
    // `setTimeout(… "Execution timed out")` built from its `timeout` option.
    const loader = {
      load: (spec: { modules: Record<string, string> }) => {
        generated = spec.modules["executor.js"] ?? "";
        return { getEntrypoint: () => ({ evaluate: async () => ({ result: 1, logs: [] }) }) };
      },
    };
    // Unchecked and named: `WorkerLoader` is a workerd binding with no
    // constructible form; codemode reaches only `load`. The double rides the
    // prototype the way helpers/jsrpc-stub.ts builds stubs.
    const workerLoader: WorkerLoader = Object.create(loader);
    const executor = new PreambleCraftedExecutor(workerLoader, emptyCraftStore(), sql);

    await executor.execute("return 1", []);

    expect(generated).toContain("Execution timed out");
    // The regression: codemode's own default put 60000 here, so a detached
    // program died 30s after the model was promised it was still running.
    expect(generated).not.toContain("60000");
    expect(generated).toContain(String(NO_TIMER_DEADLINE_MS));
  });
});
