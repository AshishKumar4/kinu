/**
 * Nimbus long-running processes: `startProcess` answers the id every other process member takes, and a handle that
 * cannot start one says so.
 */
import { describe, expect, test } from "bun:test";
import { createNimbusWorkspaceExecutor, nimbusSessionFiles, nimbusSessionShell, type NimbusStartResult, WORKSPACE_ROOT } from "../src/index";
import { sessionFilesOver, type SessionBox } from "@kinu.run/test-utils/vfs";
import { createTestRuntime } from "./helpers";


function handleWith(start: () => Promise<NimbusStartResult>): SessionBox {
  return {
    ready: async () => {},
    exec: async (command: string) => ({
      command, success: true, stdout: "", stderr: "", exitCode: 0, duration: 0, timestamp: 0,
    }),
    startProcess: start,
    files: sessionFilesOver(),
  };
}

/** The hosted workspace over `box`, composed as cf-backend composes it. */
function workspaceOver(box: SessionBox, runtimeCatalog?: boolean) {
  const { rt } = createTestRuntime();

  return createNimbusWorkspaceExecutor({
    box, runtimeCatalog,
    inline: { vfs: nimbusSessionFiles(box.files, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }), craftStore: rt.craftStore },
  });
}

function runningStart(overrides: Partial<NimbusStartResult> = {}): NimbusStartResult {
  return {
    command: "node server.js",
    pid: 3000002,
    process: {
      pid: 3000002, command: "node server.js", argv: ["node", "server.js"], cwd: "/home/main", state: "running",
      exitCode: null, startTime: 1, endTime: null, longRunning: true, attachedTty: false,
    },
    ports: [],
    startedAt: 1_786_641_209_776,
    ...overrides,
  };
}

describe("nimbus processes — one id from start to stop", () => {
  test("the id startProcess answers is the one logs, listProcesses and stopProcess take", async () => {
    const killed: number[] = [];

    const box: SessionBox = {
      ...handleWith(async () => runningStart()),
      processes: {
        list: async () => [runningStart().process, { ...runningStart().process, pid: 9, command: "ls", longRunning: false, state: "exited" }],
        kill: async (pid: number) => {
          killed.push(pid);

          return { ok: true, pid };
        },
        logs: async (pid: number) => ({ pid, chunks: [], text: `server ${String(pid)} ready\n` }),
      },
    };

    const nimbus = workspaceOver(box);
    const started = await nimbus.tools.startProcess.execute("node server.js");

    expect(started).toEqual({ processId: "3000002" });
    expect(await nimbus.tools.logs?.execute("3000002")).toBe("server 3000002 ready\n");

    // Only what startProcess started is listed: a finished exec is no process to stop.
    expect(await nimbus.tools.listProcesses?.execute()).toEqual([{ processId: "3000002", pid: 3000002, status: "running", command: "node server.js" }]);
    expect(await nimbus.tools.stopProcess?.execute("3000002")).toEqual({ stopped: true });
    expect(killed).toEqual([3000002]);
  });

  test("a handle without startProcess names the class on the first attempt", async () => {
    const box = handleWith(async () => runningStart());
    Reflect.deleteProperty(box, "startProcess");
    const nimbus = workspaceOver(box);
    const out = await nimbus.tools.startProcess?.execute('node server.js');
    // `unsupported`, not `unavailable`: retrying cannot add a method to this handle.
    expect(out).toEqual({
      success: false,
      reason: "unsupported",
      error: "Nimbus SDK handle does not expose startProcess",
    });
  });
});

describe("nimbus capabilities — declared exactly when they run", () => {
  test("without a runtime source, python and native_binary are not claimed", () => {
    const nimbus = workspaceOver(handleWith(async () => runningStart()));
    expect(nimbus.capabilities.has("python")).toBe(false);
    expect(nimbus.capabilities.has("native_binary")).toBe(false);
    expect(nimbus.capabilities.has("javascript")).toBe(true);
    expect(nimbus.capabilities.has("process_long")).toBe(true);
    expect(nimbus.capabilities.has("net_inbound")).toBe(false);
  });

  test("with the runtime catalog bound, python and native_binary are real and declared", () => {
    const nimbus = workspaceOver(handleWith(async () => runningStart()), true);

    expect(nimbus.capabilities.has("python")).toBe(true);
    expect(nimbus.capabilities.has("native_binary")).toBe(true);
  });
});
