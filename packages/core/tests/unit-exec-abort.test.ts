// Cancellation must actually propagate from the `run` tool / executor exec
// tools. Previously the whole AbortSignal chain was a silent no-op: createShell
// dropped the signal and every remote executor ignored the trailing options.
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
import {
  createNimbusExecutor,
  type NimbusExecResult,
  type NimbusSandboxHandle,
} from '../src/execution/nimbus';
import { createTestRuntime } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { Shell } from '../src/types/primitives';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

function hangingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** One frame as the tunnel writes it onto a device socket. */
const TunnelFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(v.unknown()),
});
type TunnelFrame = v.InferOutput<typeof TunnelFrameSchema>;

/** The laptop transport over a real tunnel — the seam the cloud actually has,
 *  where a device's silence is bounded by the transport rather than by a double
 *  that answers on command. */
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
        // Simulate the agent-utils shell contract: aborted → exit 130.
        if (signal?.aborted) return { stdout: '', stderr: 'aborted', exitCode: 130 };
        return { stdout: 'done', stderr: '', exitCode: 0 };
      },
    };
    const rtWithShell: AgentRuntime = { ...rt, shell };
    const tools = buildBuiltinTools({ rt: rtWithShell });
    const run = toolExecute<{ command: string; runtime?: string }, string>(tools.run);

    controller.abort();
    const result = await run(
      { command: 'cat big.txt && cat big2.txt' },
      { toolCallId: 'abort-test', messages: [], abortSignal: controller.signal },
    );
    expect(result).toContain('exit 130');
    expect(executed).toEqual(['cat big.txt && cat big2.txt']);
  });
});

describe('remote executor exec abort', () => {
  // KINU-033. The sandbox's signal is not a wait-breaker: core hands it to the
  // adapter, which kills the container process it started and settles only once
  // that process is gone. Core's own job shrank to two things — pass the signal
  // on, and refuse to DISPATCH for a caller who has already given up.
  /** What the container was asked to run, and whether the caller's signal
   *  reached it. `signalled: false` is the defect this suite exists to catch. */
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
      exposePort: async (port) => ({ url: `https://preview.example.com/${port}`, port }),
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
    // The retry exists to swallow the eviction disconnect window. It must not
    // start a SECOND container process for a turn that has already stopped
    // caring about the first.
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

  /**
   * KINU-N021. Aborting a laptop exec used to end the WAIT and nothing else:
   * the protocol had no way to say "stop", so the command — and anything it had
   * started — kept running on the user's machine after the turn reported
   * stopped. Now the abort path sends a cancellation keyed on the id the
   * command was issued under, waits for the device's answer, and reports what
   * that answer actually was.
   */
  interface LaptopCall { method: string; params: JsonValue[]; requestId?: string }

  function cancellableTransport(
    cancelAnswer: (requestId: string) => Promise<JsonValue | undefined>,
  ) {
    const calls: LaptopCall[] = [];
    const transport: DeviceTransport = {
      rpc: async (method, params, opts) => {
        const call: LaptopCall = { method, params };
        if (opts?.requestId !== undefined) call.requestId = opts.requestId;
        calls.push(call);
        if (method !== DEVICE_CANCEL_METHOD) return hangingPromise();
        return cancelAnswer(String(params[0]));
      },
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
    };
    return { transport, calls };
  }

  test('aborting a laptop exec cancels the command on the device by its own request id', async () => {
    const { transport, calls } = cancellableTransport(async (requestId) => ({
      requestId, cancelled: 'terminated',
    }));
    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'laptop exec stopped — the device confirmed its owned command process group terminated; separately sessioned processes may still run',
    });

    // ONE identity for both frames: the cancellation names the command by the
    // id the command was issued under, so there is no second correlation that
    // could drift out of step and stop the wrong process.
    expect(calls.map((call) => call.method)).toEqual(['exec', DEVICE_CANCEL_METHOD]);
    const execRequestId = calls[0].requestId;
    if (execRequestId === undefined) throw new Error('the exec call carried no request identity');
    expect(calls[1].params[0]).toBe(execRequestId);
    expect(calls[1].params[1]).toBe(DEVICE_CANCEL_PROTOCOL);
  });

  test('a command that finished first is reported as gone, not as killed', async () => {
    // The completion/cancel race. The daemon holds no record of the request, so
    // claiming a kill would be a claim about a process that had already ended.
    const { transport } = cancellableTransport(async (requestId) => ({
      requestId, cancelled: 'unknown',
    }));
    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('true', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'laptop exec stopped — no active command control entry remained on the device; backgrounded or separately sessioned processes may still run',
    });
  });

  test('a device too old to stop a command says so instead of claiming it stopped', async () => {
    // Mixed versions, from the caller's side. The refusal has to name the gap:
    // an abort that reads as "terminated" here would be a lie about the user's
    // own machine.
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

  /**
   * The far end is a program on somebody else's computer, and the three ways it
   * can be adversarial about a kill all reduce to one rule: nothing but an
   * answer NAMING this command, arriving inside the wait, confirms a stop.
   */
  test('a device that ignores the cancellation is a failed stop, and its late answer cannot upgrade that', async () => {
    // A REAL tunnel, because the bound on an unanswered cancellation is the
    // tunnel's deadline: a transport double could assert the report and never
    // that anything ends the wait at all.
    const frames: TunnelFrame[] = [];
    const socket: TunnelSocket = {
      readyState: 1,
      send: (data: string) => { frames.push(v.parse(TunnelFrameSchema, JSON.parse(data))); },
    };
    // A short control deadline and a distant liveness probe: the only thing
    // that can end this cancellation is the deadline under test. The wait below
    // is the tunnel's own rejection, never a sleep — but the deadline itself is
    // real time, because the subject IS that the transport bounds a silent
    // machine at all.
    const tunnel = new DeviceTunnel(socket, 25, 60_000);
    const provider = createDeviceTunnelExecutor(tunnelTransport(tunnel));
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('make -j', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    await expect(pending).rejects.toThrow(/device RPC timeout/);
    // The frame went out and was ignored — this is a silent machine, not a
    // cancellation this side failed to send.
    expect(frames.map((frame) => frame.method)).toEqual(['exec', DEVICE_CANCEL_METHOD]);

    // The device answers when it suits it, long after the wait ended. A claim
    // that arrives after the caller was told the stop was unconfirmed cannot
    // retroactively become a confirmed one.
    tunnel.handleMessage(JSON.stringify({
      id: frames[1].id,
      result: { requestId: String(frames[1].params[0]), cancelled: 'terminated' },
    }));
    await expect(pending).rejects.toThrow(/could not stop the command, which may still be running/);
    tunnel.dispose();
  });

  test('an answer that names another command confirms nothing about this one', async () => {
    // The daemon echoes the request it acted on. An echo naming a DIFFERENT
    // command is a mispaired or lying far end, and reading it as this
    // command's answer would report a stopped command whose processes run on.
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
    // The completion/cancel boundary from the caller's side: the command had
    // already finished on the machine (so the daemon holds no control entry),
    // and its result frame arrives after the abort was reported.
    const calls: LaptopCall[] = [];
    const held = Promise.withResolvers<JsonValue>();
    const transport: DeviceTransport = {
      rpc: (method, params) => {
        calls.push({ method, params });
        if (method !== DEVICE_CANCEL_METHOD) return held.promise;
        return Promise.resolve({ requestId: String(params[0]), cancelled: 'unknown' });
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
      message: 'laptop exec stopped — no active command control entry remained on the device; backgrounded or separately sessioned processes may still run',
    });

    // The command's own result lands now. Awaiting the very promise the
    // transport handed out is what proves the executor has SEEN it settle.
    held.resolve({ stdout: 'all 900 tests passed', stderr: '', exitCode: 0 });
    await held.promise;

    // The turn ended on the abort. The held result publishes nothing: not a
    // value to the caller, and not another frame to the machine.
    await expect(pending).rejects.toThrow(/no active command control entry/);
    expect(calls.map((call) => call.method)).toEqual(['exec', DEVICE_CANCEL_METHOD]);
  });

  test('nimbus exec stops waiting and throws AbortError on abort', async () => {
    const box: NimbusSandboxHandle = {
      ready: async () => {},
      exec: () => hangingPromise<NimbusExecResult>(),
      files: {
        read: async () => null, write: async () => {}, list: async () => [],
        exists: async () => false, delete: async () => {},
      },
    };
    const provider = createNimbusExecutor({ box });
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a pre-aborted signal sends nothing, and says nothing ran', async () => {
    // Cancel-before-spawn. No frame went out, so there is no command and no
    // process group anywhere — and no cancellation to send either, which is the
    // one abort case that must NOT reach the device.
    const calls: string[] = [];
    const transport: DeviceTransport = {
      rpc: async (method) => { calls.push(method); return { stdout: '', stderr: '', exitCode: 0 }; },
      status: () => ({ connected: true, registered: true, toolchain: null }),
      refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
    };
    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(provider.tools.exec.execute('ls', { signal: controller.signal }))
      .rejects.toMatchObject({
        name: 'AbortError',
        message: 'laptop exec stopped before the command was sent — nothing ran on the device',
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
