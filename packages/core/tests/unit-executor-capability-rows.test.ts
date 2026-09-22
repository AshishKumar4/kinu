// Each executor's declared capabilities, asserted through the `, runs: …` sentence the model reads,
// built by the real router from the real provider.
import { describe, expect, test } from 'bun:test';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import { createDeviceTunnelExecutor, type DeviceTransport } from '../src/execution/device-tunnel-executor';
import { DefaultExecutionRouter } from '../src/execution/router';
import type { ExecutorProvider } from '../src/execution/types';
import {
  renderDynamicContextBlock, buildSystemPromptSync,
  deviceToolchainAnswer, DEVICE_TOOLCHAIN_TTL_MS,
} from '../src/index';
import { createTestRuntime } from '@kinu.run/test-utils';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

/** Rows `DefaultExecutionRouter.listExecutors` hands the prompt for one real provider. */
function routerRows(provider: ExecutorProvider) {
  const router = new DefaultExecutionRouter();
  router.register(provider);

  return router.listExecutors();
}

/** The `, runs: …` line for one real provider through the real renderer. */
function runsLine(provider: ExecutorProvider): string {
  const block = renderDynamicContextBlock({ executors: routerRows(provider) });
  const line = block?.split('\n').find((row) => row.startsWith(`- ${provider.name}:`));

  if (line === undefined) throw new Error(`no rendered row for ${provider.name}`);

  return line;
}

const connectedDevice: DeviceTransport = {
  status: () => ({ connected: true, registered: true, toolchain: null }),
  refreshStatus: async () => ({ connected: true, registered: true, toolchain: null }),
  rpc: async () => undefined,
};

/** A present, never-called container binding: `connected` follows from the binding existing. */
const boundContainer: SandboxHandle = (() => {
  const unreachable = async (): Promise<never> => {
    throw new Error('the capability row must not depend on a container reply');
  };

  return {
    exec: unreachable, readFile: unreachable, writeFile: unreachable,
    listFiles: unreachable, deleteFile: unreachable, exposePort: unreachable,
    unexposePort: unreachable, getExposedPorts: unreachable,
    ...sandboxHandleLifecycle,
  };
})();

describe('sandbox capability row', () => {
  // Inventory of record: docs/EXECUTION-LAYER-SPEC.md, AGENTS.md's Container row.
  test('tells the model the container runs TypeScript, not just a shell with npm in it', () => {
    const line = runsLine(createSandboxExecutor(boundContainer));

    // `bun` runs .ts directly; `tsc` is absent and irrelevant.
    expect(line).toContain('typescript');
    expect(line).toContain('javascript');
    expect(line).toContain('native_binary');
  });

  test('claims neither python nor docker — both probed absent at exit 127', () => {
    const line = runsLine(createSandboxExecutor(boundContainer));

    // Python runs only in the workspace; routing it here is the escalation the spec refuses.
    expect(line).not.toContain('python');
    expect(line).not.toContain('docker');
  });
});

/** A machine that resolved exactly `binaries` on its PATH `secondsAgo` ago. */
function probedDevice(binaries: readonly string[], secondsAgo = 0): DeviceTransport {
  const status = {
    connected: true,
    registered: true,
    toolchain: deviceToolchainAnswer(binaries, Date.now() - secondsAgo * 1_000),
  };

  return { status: () => status, refreshStatus: async () => status, rpc: async () => undefined };
}

describe('tunneled device capability row', () => {
  test('an unprobed machine claims nothing, and denies nothing either', () => {
    const line = runsLine(createDeviceTunnelExecutor(connectedDevice));

    // Nothing has probed the device, so nothing may be claimed: an over-claim fails on the user's machine.
    const [runs, notMeasured] = line.split(', not measured here: ');

    for (const unprobed of ['javascript', 'typescript', 'python', 'npm', 'git', 'docker', 'gpu']) {
      expect(runs).not.toContain(unprobed);
    }

    // Nor reported absent: omission reads to the model like a denial.
    expect(runs).toBe('- device: connected, files at /pc, runs: native_binary, shell, fs_owned, net_outbound, process_spawn');
    expect(notMeasured).toBe('javascript, typescript, python, npm, git, docker, gpu');
  });

  test('a probed machine offers the languages it actually has, and only those', () => {
    // One answer, three states: javascript evidenced; typescript/npm/git absent; docker/gpu unknown (no PATH can settle them).
    const line = runsLine(createDeviceTunnelExecutor(probedDevice(['node', 'python3'])));

    expect(line).toBe(
      '- device: connected, files at /pc, runs: javascript, python, native_binary, shell, fs_owned, net_outbound, process_spawn'
      + ', not measured here: docker, gpu',
    );
  });

  test('a stale answer cannot masquerade as a fresh one', () => {
    // An answer is evidence for a bounded time (the agent can install toolchains); then the row knows nothing again.
    const stale = runsLine(createDeviceTunnelExecutor(
      probedDevice(['node', 'python3'], DEVICE_TOOLCHAIN_TTL_MS / 1_000 + 1),
    ));

    expect(stale).not.toContain('runs: javascript');
    expect(stale).toContain('not measured here: javascript, typescript, python, npm, git, docker, gpu');
  });

  test('the block tells the model that "not measured" is ignorance, not a denial', () => {
    const block = renderDynamicContextBlock({
      executors: routerRows(createDeviceTunnelExecutor(connectedDevice)),
    });

    expect(block).toContain('It may well work, so try it before ruling it out');
  });

  test('declares no capability its own tool surface cannot exercise', () => {
    const provider = createDeviceTunnelExecutor(connectedDevice);
    const line = runsLine(provider);

    // Nothing in `device` can keep a process alive between turns or signal one.
    expect(Object.keys(provider.tools).sort())
      .toEqual(['exec', 'exists', 'readFile', 'readdir', 'writeFile']);
    expect(line).not.toContain('process_long');
    expect(line).not.toContain('process_signal');
  });

  test('does not offer inbound ports its own exposePort refuses', async () => {
    const provider = createDeviceTunnelExecutor(connectedDevice);

    // The device is behind the user's NAT; this provider opens nothing back to it.
    expect(await provider.exposePort?.(8080)).toMatchObject({ supported: false });
    expect(runsLine(provider)).not.toContain('net_inbound');
  });

  test('is left out of the preview instructions it can never honour', () => {
    // prompt.ts builds the "Showing a running app" recipe from executors declaring net_inbound.
    const { rt } = createTestRuntime();

    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
        {
          name: 'device', kind: 'device',
          capabilities: [...createDeviceTunnelExecutor(connectedDevice).capabilities],
          available: true, configured: true, active: true, status: 'active',
        },
      ],
    });

    expect(prompt).toContain('workspace.exposePort(port)');
    expect(prompt).not.toContain('device.exposePort(port)');
  });
});
