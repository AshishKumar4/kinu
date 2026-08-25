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
import { initCraftScoreTables, NO_TIMER_DEADLINE_MS } from "@kinu.run/core";
import { createTestSql } from "@kinu.run/test-utils";
import { adaptCloudflareSandbox } from "../src/sandbox-exec-lane";

// codemode reaches `cloudflare:workers` at load, so that specifier must be
// stubbed before its module is evaluated — hence the one dynamic import. The
// exec-lane adapter needs no stub at all, which is the point of it living
// outside `runtime.ts`.
mock.module("cloudflare:workers", () => ({
  RpcTarget: class {}, WorkerEntrypoint: class {}, DurableObject: class {},
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
}

/**
 * The SDK surface `adaptCloudflareSandbox` consumes, over the process lane.
 * `waitsBeforeExit` models the ONE thing that can interrupt the observation: the
 * process log stream idles out after 300s of silence while the process is still
 * perfectly alive. Each entry is one such interruption.
 */
function fakeBox(input: { waitsBeforeExit?: number; exitCode?: number } = {}) {
  const calls: BoxCalls = { exec: [], started: [] };
  let interruptions = input.waitsBeforeExit ?? 0;
  const proc: ProcessDouble = {
    id: "proc-1",
    status: "running",
    waitForExit: async () => {
      if (interruptions > 0) {
        interruptions -= 1;
        throw new Error("Stream idle timeout after 300000ms");
      }
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
    readFile: async () => ({ content: "" }),
    writeFile: async () => undefined,
    listFiles: async () => ({ files: [] }),
    deleteFile: async () => undefined,
    exposePort: async (port: number) => ({ url: `https://p/${port}`, port }),
    unexposePort: async () => undefined,
    getExposedPorts: async () => [],
    startSupervised: async () => ({ processId: "sup-1" }),
    listSupervised: async () => [],
    notePortExposed: async () => {},
    notePortRemoved: async () => {},
  };
  // Unchecked and named: `KinuSandbox` is a Durable Object class, so a test
  // cannot construct one. The double rides the prototype the way
  // helpers/jsrpc-stub.ts builds stubs — the adapter reaches only methods, and
  // exactly the members above are reachable, which is the boundary under test.
  const sdk: KinuSandbox = Object.create(box);
  // The egress preflight is a no-op here: which LANE a command takes is what
  // this file measures, and the preflight has its own suite
  // (unit-egress-interception.test.ts).
  return { calls, handle: adaptCloudflareSandbox(sdk, async () => {}) };
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
    initCraftScoreTables((ddl: string) => db.exec(ddl));
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
