// The AbortSignal chain from `shell` and executor exec tools; one dropped link makes it a no-op.
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import { createDeviceTunnelExecutor, type DeviceTransport } from '../src/execution/device-tunnel-executor';
import {
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_MISPAIRED, DEVICE_CANCEL_PROTOCOL, DEVICE_UNKNOWN_METHOD,
  DeviceTunnel, TUNNEL_DISCONNECTED, type TunnelSocket,
} from '../src/execution/device-tunnel';
import type { JsonValue } from '../src/utils/json';
import { createNimbusWorkspaceExecutor } from '../src/tools/inline-executor';
import {
  nimbusSessionFiles, nimbusSessionShell,
  type NimbusExecResult,
  type NimbusSandboxHandle,
} from '../src/execution/nimbus';
import { createTestRuntime, storesFor } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Shell } from '../src/types/primitives';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';
import type { CommandResult } from '../src/execution/exec-result';

function hangingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const TunnelFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(v.unknown()),
});

type TunnelFrame = v.InferOutput<typeof TunnelFrameSchema>;

/** Over a real tunnel, so a silent device is bounded by the transport, not a test double. */
function tunnelTransport(tunnel: DeviceTunnel): DeviceTransport {
  const connected = { connected: true, registered: true, toolchain: null } as const;

  return {
    rpc: (method, params, opts) => tunnel.rpc(method, params, opts),
    status: () => connected,
    refreshStatus: async () => connected,
  };
}

describe('run tool — workspace shell abort', () => {
  test('a long-running command list terminates on abort (exit 130, later commands skipped)', async () => {
    const { rt } = createTestRuntime();
    const controller = new AbortController();
    const executed: string[] = [];

    const ShellOptionsSchema = v.object({
      stdin: v.optional(v.string()),
      signal: v.optional(v.instance(AbortSignal)),
    });

    const shell: Shell = {
      exec: async (command, options) => {
        const parsed = v.safeParse(ShellOptionsSchema, options);
        const signal = parsed.success ? parsed.output.signal : undefined;
        executed.push(command);

        if (signal?.aborted) return { stdout: '', stderr: 'aborted', exitCode: 130 };

        return { stdout: 'done', stderr: '', exitCode: 0 };
      },
    };

    const rtWithShell: AgentRuntime = { ...rt, shell };
    const tools = buildBuiltinTools({ rt: rtWithShell, history: storesFor(rtWithShell).history });
    const run = toolExecute<{ command: string; runtime?: string }, CommandResult>(tools.shell);

    controller.abort();

    const pending = run(
      { command: 'cat big.txt && cat big2.txt' },
      { toolCallId: 'abort-test', messages: [], abortSignal: controller.signal },
    );

    await expect(pending).rejects.toMatchObject({ code: 'io', execution: { exitCode: 130 }, message: expect.stringContaining('exit 130') });
    expect(executed).toEqual(['cat big.txt && cat big2.txt']);
  });
});

describe('remote executor exec abort', () => {
  // KINU-033: core forwards the signal to the sandbox adapter and refuses to dispatch when already aborted.
  interface ObservedExec {
    command: string;
    signalled: boolean;
  }

  function sandboxHandleThatHonours(exec: SandboxHandle['exec']) {
    const seen: ObservedExec[] = [];

    const handle: SandboxHandle = {
      exec: (command, opts) => {
        seen.push({ command, signalled: opts?.signal !== undefined });

        return exec(command, opts);
      },
      readFile: async () => ({}),
      writeFile: async () => {},
      listFiles: async () => ({ files: [] }),
      deleteFile: async () => {},
      exposePort: async (port) => ({ url: `https://preview.example.com/${port}`, port, route: { reached: true } }),
      unexposePort: async () => {},
      getExposedPorts: async () => [],
      ...sandboxHandleLifecycle,
    };

    return { handle, seen };
  }

  test('sandbox exec hands the signal to the container and reports the kill it performed', async () => {
    const { handle, seen } = sandboxHandleThatHonours((_command, opts) => {
      const { promise, reject } = Promise.withResolvers<{ exitCode?: number }>();
      opts?.signal?.addEventListener('abort', () => {
        reject(new DOMException(
          'sandbox exec cancelled — container process proc-1 was killed',
          'AbortError',
        ));
      }, { once: true });

      return promise;
    });

    const provider = createSandboxExecutor(handle, 'preview.example.com');
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('container process proc-1 was killed'),
    });
    expect(seen).toEqual([{ command: 'sleep 9999', signalled: true }]);
  });

  test('a pre-aborted sandbox signal starts no container process at all', async () => {
    const { handle, seen } = sandboxHandleThatHonours(async () => ({ exitCode: 0 }));
    const provider = createSandboxExecutor(handle, 'preview.example.com');
    const controller = new AbortController();
    controller.abort();

    await expect(provider.tools.exec.execute('ls', { signal: controller.signal }))
      .rejects.toMatchObject({
        name: 'AbortError',
        message: expect.stringContaining('no container process was started'),
      });
    expect(seen).toEqual([]);
  });

  test('a transient failure is not retried for a caller who aborted meanwhile', async () => {
    // The eviction retry must not start a second container process after abort.
    const controller = new AbortController();

    const { handle, seen } = sandboxHandleThatHonours(async () => {
      controller.abort();
      throw new Error('Network connection lost.');
    });

    const provider = createSandboxExecutor(handle, 'preview.example.com');

    await expect(provider.tools.exec.execute('ls', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
  });

  /** KINU-N021: abort sends a cancellation keyed on the command's id and reports the device's actual answer. */
  interface DeviceCall { method: string; params: JsonValue[]; requestId?: string }

  function cancellableTransport(
    cancelAnswer: (requestId: string) => Promise<JsonValue | undefined>,
  ) {
    const calls: DeviceCall[] = [];

    const transport: DeviceTransport = {
      rpc: async (method, params, opts) => {
        const call: DeviceCall = { method, params };

        if (opts?.requestId !== undefined) call.requestId = opts.requestId;
        calls.push(call);

        if (method !== DEVICE_CANCEL_METHOD) return hangingPromise();

        return cancelAnswer(v.parse(v.string(), params[0]));
      },
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
    };

    return { transport, calls };
  }

  test('aborting a device exec cancels the command on the device by its own request id', async () => {
    const { transport, calls } = cancellableTransport(async (requestId) => ({
      requestId, cancelled: 'terminated',
    }));

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'device exec stopped — the device confirmed its owned command process group terminated; separately sessioned processes may still run',
    });

    expect(calls.map((call) => call.method)).toEqual(['exec', DEVICE_CANCEL_METHOD]);
    const execRequestId = calls[0].requestId;

    if (execRequestId === undefined) throw new Error('the exec call carried no request identity');
    expect(calls[1].params[0]).toBe(execRequestId);
    expect(calls[1].params[1]).toBe(DEVICE_CANCEL_PROTOCOL);
  });

  test('a command that finished first is reported as gone, not as killed', async () => {
    // Completion/cancel race: the daemon has no record, so no kill may be claimed.
    const { transport } = cancellableTransport(async (requestId) => ({
      requestId, cancelled: 'unknown',
    }));

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('true', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'device exec stopped — no active command control entry remained on the device; backgrounded or separately sessioned processes may still run',
    });
  });

  test('a device too old to stop a command says so instead of claiming it stopped', async () => {
    // Mixed versions: the refusal must name the gap, not read as "terminated".
    const { transport } = cancellableTransport(() => {
      throw new Error(`${DEVICE_UNKNOWN_METHOD}: ${DEVICE_CANCEL_METHOD}`);
    });

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('make', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.toThrow(/older Kinu daemon that cannot stop a command/);
    await expect(pending).rejects.toThrow(/may still be running/);
  });

  test('a kill the device refused is reported as a kill failure', async () => {
    const { transport } = cancellableTransport(() => {
      throw new Error('EPERM: operation not permitted, kill -12345');
    });

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('make', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    await expect(pending).rejects.toThrow(/EPERM/);
  });

  test('a device that vanished mid-cancellation does not claim a confirmed stop', async () => {
    const { transport } = cancellableTransport(() => {
      throw new Error(TUNNEL_DISCONNECTED);
    });

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('make', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(
      /the device disconnected before it confirmed the command stopped/,
    );
  });

  /** Only an answer naming this command, inside the wait, confirms a stop. */
  test('a device that ignores the cancellation is a failed stop, and its late answer cannot upgrade that', async () => {
    // A real tunnel, because the bound under test is the tunnel's own deadline.
    const frames: TunnelFrame[] = [];

    const socket: TunnelSocket = {
      readyState: 1,
      send: (data: string) => { frames.push(v.parse(TunnelFrameSchema, JSON.parse(data))); },
    };

    const tunnel = new DeviceTunnel(socket, 25, 60_000);
    const provider = createDeviceTunnelExecutor(tunnelTransport(tunnel));
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('make -j', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    await expect(pending).rejects.toThrow(/device RPC timeout/);
    expect(frames.map((frame) => frame.method)).toEqual(['exec', DEVICE_CANCEL_METHOD]);

    // A late answer cannot upgrade an unconfirmed stop.
    tunnel.handleMessage(JSON.stringify({
      id: frames[1].id,
      result: { requestId: String(frames[1].params[0]), cancelled: 'terminated' },
    }));
    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    tunnel.dispose();
  });

  test('an answer that names another command confirms nothing about this one', async () => {
    // An echo naming a different command must not count as this one's answer.
    const { transport } = cancellableTransport(async () => ({
      requestId: 'rpc-elsewhere0-4', cancelled: 'terminated',
    }));

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('cargo build', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    await expect(pending).rejects.toThrow(DEVICE_CANCEL_MISPAIRED);
  });

  test('a completion that lands after the abort never becomes the tool\'s answer', async () => {
    // The command already finished on the machine; its result arrives after the abort was reported.
    const calls: DeviceCall[] = [];
    const held = Promise.withResolvers<JsonValue>();

    const transport: DeviceTransport = {
      rpc: (method, params) => {
        calls.push({ method, params });

        if (method !== DEVICE_CANCEL_METHOD) return held.promise;

        return Promise.resolve({ requestId: v.parse(v.string(), params[0]), cancelled: 'unknown' });
      },
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
    };

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('bun test', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'device exec stopped — no active command control entry remained on the device; backgrounded or separately sessioned processes may still run',
    });

    held.resolve({ stdout: 'all 900 tests passed', stderr: '', exitCode: 0 });
    await held.promise;

    await expect(pending).rejects.toThrow(/no active command control entry/);
    expect(calls.map((call) => call.method)).toEqual(['exec', DEVICE_CANCEL_METHOD]);
  });

  test('the hosted workspace shell stops waiting and throws AbortError on abort', async () => {
    const box: NimbusSandboxHandle = {
      ready: async () => {},
      exec: () => hangingPromise<NimbusExecResult>(),
      files: {
        read: async () => null, write: async () => {}, list: async () => [],
        exists: async () => false, delete: async () => {},
      },
    };

    const { rt } = createTestRuntime();

    const provider = createNimbusWorkspaceExecutor({
      box, inline: { vfs: nimbusSessionFiles(box), shell: nimbusSessionShell(box), memory: rt.memory, craftStore: rt.craftStore },
    });

    const controller = new AbortController();

    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a pre-aborted signal sends nothing, and says nothing ran', async () => {
    // Cancel-before-spawn: no frame went out, so no cancellation may reach the device.
    const calls: string[] = [];

    const transport: DeviceTransport = {
      rpc: async (method) => {
        calls.push(method);

        return { stdout: '', stderr: '', exitCode: 0 };
      },
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
    };

    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(provider.tools.exec.execute('ls', { signal: controller.signal }))
      .rejects.toMatchObject({
        name: 'AbortError',
        message: 'device exec stopped before the command was sent — nothing ran on the device',
      });
    expect(calls).toEqual([]);
  });

  test('without a signal, exec resolves normally', async () => {
    const transport: DeviceTransport = {
      rpc: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
    };

    const provider = createDeviceTunnelExecutor(transport);
    expect(await provider.tools.exec.execute('ls')).toBe('ok');
  });
});
