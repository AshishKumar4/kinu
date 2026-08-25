// What each executor DECLARES it can run, asserted through the surface that
// makes it matter.
//
// The declared set is not documentation. It is rendered into the agent's own
// execution block (`prompting/volatile-context.ts` — `— runs: …`), so it is
// where the model decides to send work: a capability declared but absent routes
// work to a machine that cannot do it, and one present but undeclared means the
// work never goes there at all. So every test below asserts the SENTENCE THE
// MODEL READS, built by the real router from the real provider. A test that
// asserted the literal array would only be a second copy of the source, and
// would agree with it while it was wrong.
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

/** The rows the real projection (`DefaultExecutionRouter.listExecutors`) hands
 *  the prompt for one real provider. */
function routerRows(provider: ExecutorProvider) {
  const router = new DefaultExecutionRouter();
  router.register(provider);
  return router.listExecutors();
}

/** The `— runs: …` line for one real provider, through that projection and the
 *  real renderer. */
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

/** A container binding that is present and never called: the row renders only
 *  for an executor the router reports as reachable, and `connected` is a
 *  function of the binding existing rather than of any reply. */
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
  // Inventory of record: `executeInExecutor` against the deployed container
  // reports node v22.23.2, bun, sh/bash, git, npm, jq and curl PRESENT
  // (docs/EXECUTION-LAYER-SPEC.md, AGENTS.md's Container row).
  test('tells the model the container runs TypeScript, not just a shell with npm in it', () => {
    const line = runsLine(createSandboxExecutor(boundContainer));

    // `bun` runs a .ts file directly. `tsc` is absent from the image and does
    // not bear on it — it type-checks, it is not what executes the code.
    expect(line).toContain('typescript');
    expect(line).toContain('javascript');
    // A real Linux container: the tools it ships ARE ELF binaries, so one
    // fetched with `curl` runs the same way.
    expect(line).toContain('native_binary');
  });

  test('claims neither python nor docker — both probed absent at exit 127', () => {
    const line = runsLine(createSandboxExecutor(boundContainer));

    // The workspace is the only place Python runs at all; routing Python here
    // is the escalation the spec exists to refuse.
    expect(line).not.toContain('python');
    // `docker` was declared here once, before the image was probed.
    expect(line).not.toContain('docker');
  });
});

/** A machine that answered the toolchain question `secondsAgo` ago, having
 *  resolved exactly `binaries` on its own PATH. */
function probedDevice(binaries: readonly string[], secondsAgo = 0): DeviceTransport {
  const status = {
    connected: true,
    registered: true,
    toolchain: deviceToolchainAnswer(binaries, Date.now() - secondsAgo * 1_000),
  };
  return { status: () => status, refreshStatus: async () => status, rpc: async () => undefined };
}

describe('tunneled laptop capability row', () => {
  test('an unprobed machine claims nothing, and denies nothing either', () => {
    const line = runsLine(createDeviceTunnelExecutor(connectedDevice));

    // The device is the user's own hardware behind a consent grant they made.
    // Nothing has asked it what it holds, so none of these may be CLAIMED — an
    // over-claim sends work there and it fails on their machine.
    const [runs, notMeasured] = line.split(' — not measured here: ');
    for (const unprobed of ['javascript', 'typescript', 'python', 'npm', 'git', 'docker', 'gpu']) {
      expect(runs).not.toContain(unprobed);
    }
    // And none may be reported ABSENT either. The row that replaced this one
    // simply omitted them, which reads to the model exactly like a denial: it
    // would never try python on a machine that may well have python.
    expect(runs).toBe('- laptop: connected — files at /pc — runs: native_binary, shell, fs_owned, net_outbound, process_spawn');
    expect(notMeasured).toBe('javascript, typescript, python, npm, git, docker, gpu');
  });

  test('a probed machine offers the languages it actually has, and only those', () => {
    // `node` runs .js but not .ts, and is not a package manager. So one answer
    // produces all three states at once: javascript is evidenced, typescript /
    // npm / git were looked for and not found, and docker / gpu were not looked
    // for because nothing on a PATH could settle them.
    const line = runsLine(createDeviceTunnelExecutor(probedDevice(['node', 'python3'])));

    expect(line).toBe(
      '- laptop: connected — files at /pc — runs: javascript, python, native_binary, shell, fs_owned, net_outbound, process_spawn'
      + ' — not measured here: docker, gpu',
    );
  });

  test('a stale answer cannot masquerade as a fresh one', () => {
    // The agent can install a toolchain onto that machine through `laptop.exec`,
    // so an answer is evidence for a bounded time. Past it the row goes back to
    // knowing nothing — it does not keep claiming, and it does not start denying.
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

    expect(block).toContain('it may well work, so try it rather than ruling it out');
  });

  test('declares no capability its own tool surface cannot exercise', () => {
    const provider = createDeviceTunnelExecutor(connectedDevice);
    const line = runsLine(provider);

    // Nothing in the `laptop` namespace can keep a process alive between turns
    // or signal one, so neither may be declared.
    expect(Object.keys(provider.tools).sort())
      .toEqual(['exec', 'exists', 'readFile', 'readdir', 'writeFile']);
    expect(line).not.toContain('process_long');
    expect(line).not.toContain('process_signal');
  });

  test('does not offer inbound ports its own exposePort refuses', async () => {
    const provider = createDeviceTunnelExecutor(connectedDevice);

    // The device sits behind the user's NAT; this provider opens nothing back
    // to it, and said so while declaring net_inbound anyway.
    expect(await provider.exposePort?.(8080)).toMatchObject({ supported: false });
    expect(runsLine(provider)).not.toContain('net_inbound');
  });

  test('is left out of the preview instructions it can never honour', () => {
    // net_inbound is not prompt decoration: prompt.ts builds the "Showing a
    // running app" recipe from exactly the executors that declare it, naming
    // `<name>.exposePort(port)`. While laptop declared it, the model was told
    // to call a method that answers `supported: false`.
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt, {
      backend: 'cf',
      executors: [
        { name: 'workspace', kind: 'workspace', capabilities: ['net_inbound'], available: true, configured: true, active: true, status: 'active' },
        {
          name: 'laptop', kind: 'laptop',
          capabilities: [...createDeviceTunnelExecutor(connectedDevice).capabilities],
          available: true, configured: true, active: true, status: 'active',
        },
      ],
    });

    expect(prompt).toContain('workspace.exposePort(port)');
    expect(prompt).not.toContain('laptop.exposePort(port)');
  });
});
