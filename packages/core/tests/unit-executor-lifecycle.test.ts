import { describe, expect, test } from "bun:test";
import { sandboxHandleLifecycle } from "./helpers/sandbox-handle-lifecycle";
import {
  DefaultExecutionRouter,
  createNimbusExecutor,
  createSandboxExecutor,
  isSandboxTransientError,
  type NimbusSandboxHandle,
  type SandboxHandle,
} from "../src/index";

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
    ...sandboxHandleLifecycle,
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
        calls.push(`write:${path}:${content instanceof Uint8Array ? content.byteLength : content}`);
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
      async ensure(specs: string | string[]): Promise<undefined> {
        calls.push(`ensure:${Array.isArray(specs) ? specs.join(",") : specs}`);
        return undefined;
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
    router.register(createSandboxExecutor(handle, "kinu.example.test"));

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

  // KINU-033. This used to assert the opposite — that the signal was STRIPPED
  // before the SDK call — which is precisely why an abort cancelled nothing: the
  // adapter owns the container process id, so a signal that never reaches it
  // cannot kill anything, and core answered `cancelled` over a command still
  // writing to /workspace.
  test("sandbox exec hands the AbortSignal to the container, and no work deadline", async () => {
    const handle = sandboxHandle();
    const executor = createSandboxExecutor(handle, "kinu.example.test");
    const signal = new AbortController().signal;

    const result = await executor.tools.exec.execute("echo ok", { signal });

    expect(result).toBe("ok");
    // /workspace is the executor's own default cwd, passed explicitly. No
    // `timeout`: this lane carries no work deadline, because a lane deadline
    // outranks every detach window above it (see
    // unit-exec-detach-ceiling.test.ts).
    expect(handle.execOptions).toEqual([{ cwd: "/workspace", signal }]);
  });

  test("sandbox exec with no caller signal sends none", async () => {
    const handle = sandboxHandle();
    const executor = createSandboxExecutor(handle, "kinu.example.test");

    expect(await executor.tools.exec.execute("echo ok")).toBe("ok");
    expect(handle.execOptions).toEqual([{ cwd: "/workspace" }]);
  });

  test("sandbox exists shell-quotes command substitutions in paths", async () => {
    const handle = sandboxHandle();
    const executor = createSandboxExecutor(handle);
    const path = "/tmp/$(touch /tmp/pwned)";

    expect(await executor.tools.exists.execute(path)).toBe("false");
    expect(handle.calls).toContain(`exec:test -e '${path}' && echo true || echo false`);
  });

  test("sandbox exists maps a transport failure to a refusal, not a rejection", async () => {
    const handle = sandboxHandle();
    handle.exec = async () => { throw new Error("transport down"); };
    const executor = createSandboxExecutor(handle);

    const out = await executor.tools.exists.execute("/workspace/a.md");
    expect(String(out)).toContain("transport down");
    expect(JSON.parse(String(out))).toMatchObject({ reason: "io" });
  });

  test("sandbox port discovery preserves a real SDK failure", async () => {
    const handle = sandboxHandle();
    handle.getExposedPorts = async () => { throw new Error("preview registry unavailable"); };
    const executor = createSandboxExecutor(handle, "kinu.example.test");

    await expect(executor.listExposedPorts!()).rejects.toThrow("preview registry unavailable");
  });

  test("a transient failure never starts a second supervised process", async () => {
    // KINU-N031: the START was inside the transient retry. Creating the process
    // and recording its durable spec are two steps inside the container, so a
    // "network connection lost" between them left a live process with no spec —
    // and the retry, which can only look for a spec, started a second one. Two
    // servers then fought over one port and the unrecorded one could not be
    // listed, stopped or restored.
    const handle = sandboxHandle();
    let starts = 0;
    let readies = 0;
    handle.ensureReady = async () => {
      readies += 1;
      if (readies === 1) throw new Error("network connection lost");
    };
    handle.startSupervisedProcess = async () => {
      starts += 1;
      throw new Error("network connection lost");
    };
    const executor = createSandboxExecutor(handle);

    const out = await executor.tools.startProcess.execute("bun run server.ts");

    // Waking the container creates nothing, so that half is still retried...
    expect(readies).toBe(2);
    // ...while the creation ran exactly once, and its failure is stated.
    expect(starts).toBe(1);
    expect(String(out)).toContain("network connection lost");
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

  test("Nimbus exposePort with no preview URL answers unsupported, not an empty URL", async () => {
    const box = nimbusBox();
    box.ports = {
      expose: async (port: number) => ({ port }),
      unexpose: async () => {},
      list: async () => [],
    };
    const executor = createNimbusExecutor({ box });
    const result = await executor.exposePort!(4321);
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toContain("4321");
  });

  test("sandbox stat of a directory with a trailing slash still finds it", async () => {
    const handle = sandboxHandle();
    const seen: string[] = [];
    const inner = handle.listFiles.bind(handle);
    handle.listFiles = async (path: string) => {
      seen.push(path);
      await inner(path);
      if (path === "/") return { files: [{ name: "/mydir", type: "directory" as const, size: 0 }] };
      return { files: [] };
    };
    const executor = createSandboxExecutor(handle, "kinu.example.test");
    expect(await executor.files!.stat("/mydir")).toMatchObject({ isDir: true });
    expect(await executor.files!.stat("/mydir/")).toMatchObject({ isDir: true });
    expect(seen).toContain("/");
  });
});

describe("sandbox transient error classification", () => {
  test("classifies Durable Object storage reset as retryable", () => {
    expect(isSandboxTransientError(
      new Error("Internal error in Durable Object storage caused object to be reset."),
    )).toBe(true);
  });

  // Admission control has TWO refusals and they arrive as different statuses.
  // Both are the platform saying "not now", so both must be retryable; the rate
  // limit was missing, so a burst of parallel escalations reached the model as a
  // hard failure while the ceiling beside it was quietly retried. Texts are the
  // SDK's own (@cloudflare/containers/dist/lib/container.js:9 and :868).
  test("classifies both container admission refusals as retryable", () => {
    expect(isSandboxTransientError(new Error(
      'There is no Container instance available at this time.\n'
      + 'This is likely because you have reached your max concurrent instance count',
    ))).toBe(true);
    expect(isSandboxTransientError(
      new Error('you are requesting too many containers per second'),
    )).toBe(true);
  });

  test("a real fault is NOT retryable, so the classifier can say no", () => {
    // A predicate that answered true for everything would make the two above
    // meaningless.
    expect(isSandboxTransientError(new Error('command not found: nope'))).toBe(false);
  });
});
