/**
 * The long-running-process contract of the Nimbus executor.
 *
 * Regression lock for the production transcript where a hello-world preview
 * burned ~20 tool calls: every server start came back looking like a
 * successful exec that had already `exited(0)`, so the agent could neither
 * keep a server alive nor learn on the first attempt that it couldn't.
 * Since @nimbus-sh/sdk 0.2.0 a started process is still running when
 * `startProcess` returns; the tool output must say so, must hand the agent
 * the observe/stop calls, and must name unavailability outright when the
 * handle cannot start one.
 */
import { describe, expect, test } from "bun:test";
import { createNimbusExecutor, type NimbusSandboxHandle, type NimbusStartResult } from "../src/index";

const baseFiles: NimbusSandboxHandle["files"] = {
  read: async () => null,
  write: async () => {},
  list: async () => [],
  stat: async () => null,
  exists: async () => false,
  delete: async () => {},
};

function handleWith(start: () => Promise<NimbusStartResult>): NimbusSandboxHandle {
  return {
    ready: async () => {},
    exec: async (command: string) => ({
      command, success: true, stdout: "", stderr: "", exitCode: 0,
    }),
    startProcess: start,
    files: baseFiles,
  };
}

function runningStart(overrides: Partial<NimbusStartResult> = {}): NimbusStartResult {
  return {
    command: "node server.js",
    pid: 3000002,
    process: {
      pid: 3000002, command: "node server.js", state: "running",
      exitCode: null, longRunning: true,
    },
    ports: [],
    startedAt: 1_786_641_209_776,
    ...overrides,
  };
}

describe("nimbus startProcess — the process is alive when the call returns", () => {
  test("a running server reports pid, long-running state, and the observe/stop calls", async () => {
    const nimbus = createNimbusExecutor({ box: handleWith(async () => runningStart()) });
    const out = String(await nimbus.tools.startProcess!.execute("node server.js"));
    expect(out).toContain("started (long-running) pid=3000002");
    expect(out).toContain("nimbus.logs(3000002)");
    expect(out).toContain("nimbus.killProcess(3000002)");
    expect(out).not.toContain("exited");
    expect(out).not.toContain("exitCode");
  });

  test("a registered port is surfaced with the preview-URL pointer", async () => {
    const nimbus = createNimbusExecutor({
      box: handleWith(async () => runningStart({ ports: [{ port: 3000, pid: 3000002 }] })),
    });
    const out = String(await nimbus.tools.startProcess!.execute("node server.js"));
    expect(out).toContain("listening on port 3000");
    expect(out).toContain("exposePort");
  });

  test("a process that already finished says so, with its exit code", async () => {
    const nimbus = createNimbusExecutor({
      box: handleWith(async () => runningStart({
        command: "echo hi",
        process: { pid: 7, command: "echo hi", state: "exited", exitCode: 0, longRunning: false },
        pid: 7,
      })),
    });
    const out = String(await nimbus.tools.startProcess!.execute("echo hi"));
    expect(out).toContain("already exited (exit 0)");
    expect(out).toContain("nimbus.logs(7)");
  });

  test("a handle without startProcess names the class on the first attempt", async () => {
    const box = handleWith(async () => runningStart());
    Reflect.deleteProperty(box, "startProcess");
    const nimbus = createNimbusExecutor({ box });
    const out = String(await nimbus.tools.startProcess!.execute("node server.js"));
    // `unsupported`, not `unavailable`: retrying cannot grow a method onto this
    // deployment's handle, and the two codes exist to keep a permanent gap apart
    // from a cold start. It lands in the census as a correct refusal.
    expect(JSON.parse(out)).toEqual({
      reason: "unsupported",
      error: "Nimbus SDK handle does not expose startProcess",
    });
  });
});

describe("nimbus capabilities — declared exactly when they run", () => {
  test("without a runtime source, python and native_binary are not claimed", () => {
    const nimbus = createNimbusExecutor({ box: handleWith(async () => runningStart()) });
    expect(nimbus.capabilities.has("python")).toBe(false);
    expect(nimbus.capabilities.has("native_binary")).toBe(false);
    expect(nimbus.capabilities.has("javascript")).toBe(true);
    expect(nimbus.capabilities.has("process_long")).toBe(true);
    expect(nimbus.capabilities.has("net_inbound")).toBe(false);
  });

  test("with the runtime catalog bound, python and native_binary are real and declared", () => {
    const nimbus = createNimbusExecutor({
      box: handleWith(async () => runningStart()),
      runtimeCatalog: true,
    });
    expect(nimbus.capabilities.has("python")).toBe(true);
    expect(nimbus.capabilities.has("native_binary")).toBe(true);
  });
});
