/**
 * The page's preview listing polls `getExposedPorts` for each executor. Defends the 0925 sweep's banner, "Could not
 * load preview listings: sandbox: this devbox is not ready: no restoration has run for this container yet": a sandbox
 * whose startup is armed is pending, not failed, while a sandbox that cannot come back still fails.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { isPreviewUrl, reconcilePreviewPorts, type ExposedPortList, type PinnedPreviewPort } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { installSandboxSdkMock, setSandboxSdk } from './helpers/sandbox-sdk';
import type { RecordedUserPlaneCalls } from './helpers/actor-harness';
import type { KinuSandbox } from '../src/kinu-sandbox';

mockAgentsSdk();

const SUFFIX = 'previews.example';

const PORT = 8788;

/** The devbox's answer for an unstarted container whose startup is armed (devbox.ts `resolveReadiness`). */
const STARTING = {
  kind: 'pending',
  reason: 'this devbox is not ready: no restoration has run for this container yet. A startup is armed, so ask again.',
} as const;

/** The devbox's refusal for a box whose attach failed with no retry armed: terminal until `attachNow()`. */
const TERMINAL = 'this devbox has no attached work directory: the snapshot chain is unreadable. '
  + 'That recovery class is terminal: call attachNow() to attempt the attach again.';

/** What the devbox answers as data, the shape that survives the Durable Object RPC. */
type Readiness = Awaited<ReturnType<KinuSandbox['resolveReadiness']>>;

/** What the container's readiness answers now; each test moves it. */
let readiness: () => Promise<Readiness> = async () => ({ kind: 'restored' });

// Reset in `afterAll`, so a later file meets the real SDK.
await installSandboxSdkMock();

setSandboxSdk({
  getSandbox: (_ns: NonNullable<Env['Sandbox']>, id: string) => ({
    resolveReadiness: async () => await readiness(),
    configureEgress: async () => {},
    // The Env terminal's command takes the process lane: no deadline asked for.
    startProcess: async () => ({ id: 'p1', exitCode: 0, waitForExit: async () => ({ exitCode: 0 }), getStatus: async () => 'exited' }),
    getProcessLogs: async () => ({ stdout: '', stderr: '' }),
    getExposedPorts: async (hostname: string) => [{
      url: `https://${String(PORT)}-${id}-p8788_ab12cd34.${hostname}/`, port: PORT, status: 'active',
    }],
  }),
});

afterAll(() => { setSandboxSdk(null); });

// Must follow the sandbox double: both helpers' module graphs reach the sandbox SDK.
const { makeEnv, orchestratorHarness } = await import('./helpers/actor-harness');

const { TEST_CREDENTIAL_ENCRYPTION_KEY } = await import('./helpers/user-do');

/** A workspace with a container and previews, whose sandbox the person has used: an idle sandbox is not asked. */
async function usedSandbox() {
  readiness = async () => ({ kind: 'restored' });
  const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [] };
  const world = { container: true };

  const { agent } = orchestratorHarness(userPlane, world, {
    ...makeEnv(undefined, userPlane, world), PREVIEW_HOST_SUFFIX: SUFFIX, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });

  expect(await agent.executeInExecutor('sandbox', 'true')).toMatchObject({ exitCode: 0 });

  return agent;
}

/** The page's state after one poll of the sandbox, over the ports it pinned before. */
function afterPoll(pinned: readonly PinnedPreviewPort[], result: ExposedPortList) {
  return reconcilePreviewPorts(pinned, [{ executor: 'sandbox', result }], (url) => isPreviewUrl(url, SUFFIX));
}

describe('the preview listing of a sandbox that is starting', () => {
  test('is pending, not a failure, and the ports the page pinned stand', async () => {
    const agent = await usedSandbox();
    const pinned = afterPoll([], await agent.getExposedPorts('sandbox'));
    expect(pinned).toMatchObject({ ports: [{ executor: 'sandbox', port: PORT }], error: null });

    // The container was recycled: the new one has not restored, and its startup is armed.
    readiness = async () => STARTING;
    const listed = await agent.getExposedPorts('sandbox');

    expect(listed).toEqual({ ports: [], pending: STARTING.reason });
    expect(afterPoll(pinned.ports, listed)).toEqual({ ports: pinned.ports, error: null });
  });

  test('that cannot come back is still a failure', async () => {
    const agent = await usedSandbox();
    const pinned = afterPoll([], await agent.getExposedPorts('sandbox'));

    readiness = async () => { throw new Error(TERMINAL); };

    const listed = await agent.getExposedPorts('sandbox');

    expect(listed).toEqual({ ports: [], error: TERMINAL });
    expect(afterPoll(pinned.ports, listed)).toEqual({ ports: pinned.ports, error: `sandbox: ${TERMINAL}` });
  });
});
