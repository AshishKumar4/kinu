import { describe, expect, test } from "bun:test";
import {
  DefaultExecutionRouter,
  createNimbusExecutor,
  createSandboxExecutor,
  isSandboxTransientError,
  type NimbusSandboxHandle,
  type SandboxHandle,
} from "../src/index.ts";

function sandboxHandle(): SandboxHandle & { calls: string[]; execOptions: unknown[] } {
  const calls: string[] = [];
  const execOptions: unknown[] = [];
  return {
    calls,
    execOptions,
    async exec(command: string, opts?: { cwd?: string; timeout?: number }) {
      calls.push(`exec:${command}`);
      execOptions.push(opts);
      return { stdout: "ok", exitCode: 0 };
    },
    async readFile(path: string) {
      calls.push(`read:${path}`);
      return { content: "file", exitCode: 0 };
    },
    async writeFile(path: string) {
      calls.push(`write:${path}`);
    },
    async listFiles(path: string) {
      calls.push(`list:${path}`);
      return { files: [] };
    },
    async deleteFile(path: string) {
      calls.push(`delete:${path}`);
    },
    async exposePort(port: number) {
      calls.push(`expose:${port}`);
      return { url: `https://${port}.example.test`, port };
    },
    async unexposePort(port: number) {
      calls.push(`unexpose:${port}`);
    },
    async getExposedPorts(hostname: string) {
      calls.push(`ports:${hostname}`);
      return [];
    },
    async createBackup() {
      calls.push("backup");
      return { id: "backup-1", dir: "/workspace", localBucket: true };
    },
    async restoreBackup() {
      calls.push("restore");
      return { success: true, id: "backup-1", dir: "/workspace" };
    },
  };
}

function nimbusBox(): NimbusSandboxHandle & { calls: string[]; execOptions: unknown[] } {
  const calls: string[] = [];
  const execOptions: unknown[] = [];
  return {
    calls,
    execOptions,
    async ready() {
      calls.push("ready");
    },
    async exec(command: string, options) {
      calls.push(`exec:${command}`);
      execOptions.push(options);
      return {
        command,
        success: true,
        stdout: "4\n",
        stderr: "",
        exitCode: 0,
        duration: 1,
        timestamp: Date.now(),
      };
    },
    files: {
      async read(path: string) {
        calls.push(`read:${path}`);
        return "hello";
      },
      async write(path: string, content: string | Uint8Array) {
        calls.push(`write:${path}:${typeof content === "string" ? content : content.byteLength}`);
      },
      async list(path: string) {
        calls.push(`list:${path}`);
        return [{ name: "a.txt", type: "file" }];
      },
      async exists(path: string) {
        calls.push(`exists:${path}`);
        return true;
      },
      async mkdir(path: string) {
        calls.push(`mkdir:${path}`);
      },
      async delete(path: string) {
        calls.push(`delete:${path}`);
      },
    },
    runtimes: {
      async ensure(specs: string | string[]) {
        calls.push(`ensure:${Array.isArray(specs) ? specs.join(",") : specs}`);
      },
      async list() {
        calls.push("runtimes");
        return { installed: [], available: [] };
      },
    },
    processes: {
      async list() {
        calls.push("processes");
        return [];
      },
      async kill(pid: number) {
        calls.push(`kill:${pid}`);
        return { ok: true, pid };
      },
      async logs(pid: number) {
        calls.push(`logs:${pid}`);
        return "log";
      },
    },
    ports: {
      async expose(port: number) {
        calls.push(`expose:${port}`);
        return { port, url: `https://nimbus.example/s/test/port/${port}/` };
      },
      async unexpose(port: number) {
        calls.push(`unexpose:${port}`);
        return { port, ok: true };
      },
      async list() {
        calls.push("ports");
        return [];
      },
    },
  };
}

describe("executor lifecycle state", () => {
  test("configured sandbox is callable but inactive until first operation", async () => {
    const handle = sandboxHandle();
    const router = new DefaultExecutionRouter();
    router.register(createSandboxExecutor(handle, "proteus.example.test"));

    const [info] = router.listExecutors().filter((e) => e.name === "sandbox");
    expect(info).toMatchObject({
      name: "sandbox",
      configured: true,
      available: true,
      active: false,
      status: "idle",
    });
    expect(handle.calls).toEqual([]);

    const result = await router.getProvider("sandbox")!.tools.exec.execute("echo ok");
    expect(result).toBe("ok");
    expect(router.listExecutors().find((e) => e.name === "sandbox")?.active).toBe(true);
    expect(handle.calls).toEqual(["exec:echo ok"]);
  });

  test("sandbox without a preview suffix stays fully available for exec and files", async () => {
    const handle = sandboxHandle();
    const executor = createSandboxExecutor(handle);

    expect(executor.isAvailable()).toBe(true);
    expect(executor.getStatus?.()).toMatchObject({
      configured: true,
      available: true,
      status: "idle",
    });
    // The status carries the preview gap so surfaces can say so up front.
    expect(executor.getStatus?.().reason).toContain("PREVIEW_HOST_SUFFIX");

    const result = await executor.tools.exec.execute("echo ok");
    expect(result).toBe("ok");
    expect(handle.calls).toEqual(["exec:echo ok"]);
  });

  test("sandbox without a preview suffix refuses port exposure with the preview reason", async () => {
    const handle = sandboxHandle();
    const executor = createSandboxExecutor(handle);

    const toolResult = await executor.tools.exposePort.execute(3000);
    expect(toolResult).toContain("PREVIEW_HOST_SUFFIX");
    const listResult = await executor.tools.listPorts.execute();
    expect(listResult).toContain("PREVIEW_HOST_SUFFIX");

    const provided = await executor.exposePort!(3000);
    expect(provided.supported).toBe(false);
    if (!provided.supported) expect(provided.reason).toContain("PREVIEW_HOST_SUFFIX");

    // A refusal must never touch the container — no probe, no SDK call.
    expect(handle.calls).toEqual([]);
  });

  test("sandbox with no handle is the not-configured stub on every surface", async () => {
    const executor = createSandboxExecutor();

    expect(executor.isAvailable()).toBe(false);
    expect(executor.getStatus?.()).toMatchObject({
      configured: false,
      available: false,
      status: "not_configured",
    });
    expect(await executor.tools.exec.execute("echo ok")).toContain("not configured");
    expect(await executor.tools.exposePort.execute(3000)).toContain("not configured");
    const provided = await executor.exposePort!(3000);
    expect(provided.supported).toBe(false);
    if (!provided.supported) expect(provided.reason).toContain("not configured");
  });

  test("sandbox exec strips AbortSignal before remote SDK calls", async () => {
    const handle = sandboxHandle();
    const executor = createSandboxExecutor(handle, "proteus.example.test");
    const signal = new AbortController().signal;

    const result = await executor.tools.exec.execute("echo ok", { signal });

    expect(result).toBe("ok");
    expect(handle.execOptions).toEqual([{ timeout: 60_000 }]);
  });

  test("Nimbus adapter uses the SDK sandbox handle shape", async () => {
    const box = nimbusBox();
    const executor = createNimbusExecutor({ box });

    expect(executor.getStatus?.()).toMatchObject({
      configured: true,
      available: true,
      active: false,
      status: "idle",
    });

    const output = await executor.tools.exec.execute("node -e 'console.log(2+2)'");
    expect(output).toBe("4\n");
    expect(executor.getStatus?.().active).toBe(true);
    expect(box.calls).toContain("exec:node -e 'console.log(2+2)'");
  });

  test("Nimbus exec strips AbortSignal before remote SDK calls", async () => {
    const box = nimbusBox();
    const executor = createNimbusExecutor({ box });
    const signal = new AbortController().signal;

    const output = await executor.tools.exec.execute("node -e 'console.log(2+2)'", { signal });

    expect(output).toBe("4\n");
    expect(box.execOptions).toEqual([undefined]);
  });
});

describe("sandbox transient error classification", () => {
  test("classifies Durable Object storage reset as retryable", () => {
    expect(isSandboxTransientError(
      new Error("Internal error in Durable Object storage caused object to be reset."),
    )).toBe(true);
  });
});
