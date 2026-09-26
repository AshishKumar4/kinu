/**
 * The page reads `getExposedPorts` when a frame says ports moved. The listing is the sandbox object's own rows: it
 * never asks the container's readiness, which starts a stopped container, so an open page cannot wake one.
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

/** What the devbox answers as data, the shape that survives the Durable Object RPC. */
type Readiness = Awaited<ReturnType<KinuSandbox['resolveReadiness']>>;

/** What the container's readiness answers now; each test moves it. */
let readiness: () => Promise<Readiness> = async () => ({ kind: 'restored' });

let readinessAsked = 0;

// Reset in `afterAll`, so a later file meets the real SDK.
await installSandboxSdkMock();

setSandboxSdk({
  getSandbox: (_ns: NonNullable<Env['Sandbox']>, id: string) => ({
    resolveReadiness: async () => {
      readinessAsked += 1;

      return await readiness();
    },
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

describe('the preview listing of a used sandbox', () => {
  test('never asks the container, so a box stopped, starting or broken is not started by a read', async () => {
    const agent = await usedSandbox();
    readiness = async () => { throw new Error('this devbox has no attached work directory'); };

    readinessAsked = 0;

    const listed = await agent.getExposedPorts('sandbox');

    expect(readinessAsked).toBe(0);
    expect(afterPoll([], listed)).toMatchObject({ ports: [{ executor: 'sandbox', port: PORT }], error: null });
  });
});
