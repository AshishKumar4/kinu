// Cancellation must actually propagate from the `run` tool / executor exec
// tools. Previously the whole AbortSignal chain was a silent no-op: createShell
// dropped the signal and every remote executor ignored the trailing options.
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@proteus/test-utils';
import * as v from 'valibot';
import { buildBuiltinTools } from '../src/tools/builtins.js';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox.js';
import { createDeviceTunnelExecutor, type DeviceTransport } from '../src/execution/device-tunnel-executor.js';
import {
  createNimbusExecutor,
  type NimbusExecResult,
  type NimbusSandboxHandle,
} from '../src/execution/nimbus.js';
import { createTestRuntime } from './helpers.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import type { Shell } from '../src/types/primitives.js';

function hangingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {});
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
  test('sandbox exec stops waiting and throws AbortError on abort', async () => {
    const handle: SandboxHandle = {
      exec: () => hangingPromise(),
      readFile: async () => ({}),
      writeFile: async () => {},
      listFiles: async () => ({ files: [] }),
      deleteFile: async () => {},
      exposePort: async (port) => ({ url: `https://preview.example.com/${port}`, port }),
      unexposePort: async () => {},
      getExposedPorts: async () => [],
      createBackup: async ({ dir }) => ({ id: 'backup', dir }),
      restoreBackup: async ({ id, dir }) => ({ success: true, id, dir }),
    };
    const provider = createSandboxExecutor(handle, 'preview.example.com');
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('laptop exec stops waiting and throws AbortError on abort', async () => {
    const transport: DeviceTransport = {
      rpc: () => hangingPromise(),
      status: () => ({ connected: true, registered: true }),
      refreshStatus: async () => ({ connected: true, registered: true }),
    };
    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();

    const pending = provider.tools.exec.execute('sleep 9999', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
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

  test('pre-aborted signal rejects before dispatching to the remote', async () => {
    const calls: string[] = [];
    const transport: DeviceTransport = {
      rpc: async (method) => { calls.push(method); return { stdout: '', stderr: '', exitCode: 0 }; },
      status: () => ({ connected: true, registered: true }),
      refreshStatus: async () => ({ connected: true, registered: true }),
    };
    const provider = createDeviceTunnelExecutor(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(provider.tools.exec.execute('ls', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });

  test('without a signal, exec resolves normally', async () => {
    const transport: DeviceTransport = {
      rpc: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
      status: () => ({ connected: true, registered: true }),
      refreshStatus: async () => ({ connected: true, registered: true }),
    };
    const provider = createDeviceTunnelExecutor(transport);
    expect(await provider.tools.exec.execute('ls')).toBe('ok');
  });
});
