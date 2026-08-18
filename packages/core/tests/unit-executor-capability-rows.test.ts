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
import { renderDynamicContextBlock, buildSystemPromptSync } from '../src/index';
import { createTestRuntime } from '@proteus/test-utils';

/** The `— runs: …` line for one real provider, through the real projection
 *  (`DefaultExecutionRouter.listExecutors`) and the real renderer. */
function runsLine(provider: ExecutorProvider): string {
  const router = new DefaultExecutionRouter();
  router.register(provider);
  const block = renderDynamicContextBlock({ executors: router.listExecutors() });
  const line = block?.split('\n').find((row) => row.startsWith(`- ${provider.name}:`));
  if (line === undefined) throw new Error(`no rendered row for ${provider.name}`);
  return line;
}

const connectedDevice: DeviceTransport = {
  status: () => ({ connected: true, registered: true }),
  refreshStatus: async () => ({ connected: true, registered: true }),
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

describe('tunneled laptop capability row', () => {
  test('claims nothing about a machine this repo never asked', () => {
    const line = runsLine(createDeviceTunnelExecutor(connectedDevice));

    // The device is the user's own hardware behind a consent grant they made.
    // Nothing on this path probes its toolchain, so none of these may be
    // declared — an over-claim sends work there and it fails on their machine.
    for (const unprobed of ['javascript', 'typescript', 'python', 'npm', 'git', 'docker', 'gpu']) {
      expect(line).not.toContain(unprobed);
    }
    // What the tunnel's own existence and this provider's tools do establish.
    expect(line).toBe('- laptop: connected — runs: native_binary, shell, fs_owned, net_outbound, process_spawn');
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
