/**
 * eval-site-preview-1-2ypddc, staging f75f06932, 2026-10-01: `node server.js` in the sandbox outran its call's window,
 * and its job read as running forever though all it did was serve the port the agent exposed, so nothing waiting on the
 * workspace ever settled. A job's command carries the job's id; when the fact can move (a port exposed or withdrawn, a
 * job detached or settled) the box's listener read records which job holds an exposed port, and the listing reads that
 * record: a hot read never asks the box.
 */
import { beforeEach, expect, test } from "bun:test";
import * as v from 'valibot';
import { JOB_STAMP_ENV, LIVE_READS, READS_CHANGED_EVENT } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { unreachableObjects } from "./helpers/bindings";
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import type { HarnessOrchestratorAgent, RecordedUserPlaneCalls } from './helpers/actor-harness';
import type { KinuDevbox } from '../src/kinu-devbox';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';

mockAgentsSdk();

const SUFFIX = 'previews.example';

const SERVED = 8001;

const SPARE = 8002;

const ReadsFrame = v.object({ type: v.literal(READS_CHANGED_EVENT), reads: v.array(v.picklist(LIVE_READS)) });

/** The box as each test sets it: what is exposed, the stamp on each port's holder, whether it is up, and every call. */
interface BoxState {
  exposed: Set<number>;
  holders: Map<number, string | null>;
  down: boolean;
  calls: string[];
}

const box: BoxState = { exposed: new Set(), holders: new Map(), down: false, calls: [] };

beforeEach(() => {
  box.exposed = new Set([SERVED, SPARE]);
  box.holders = new Map();
  box.down = false;
  box.calls = [];
});

const sandboxFor = (id: string) => ({
  resolveReadiness: async () => {
    box.calls.push('resolveReadiness');

    return { kind: 'restored' as const };
  },
  configureEgress: async () => { box.calls.push('configureEgress'); },
  restoreStatus: async () => {
    box.calls.push('restoreStatus');

    return { restoring: false, refused: undefined };
  },
  execUntimed: async () => {
    box.calls.push('execUntimed');

    return { stdout: '', stderr: '', exitCode: 0 };
  },
  releaseUntimed: async () => {},
  listFiles: async () => {
    box.calls.push('listFiles');

    return { files: [] };
  },
  getExposedPorts: async (hostname: string) => {
    box.calls.push('getExposedPorts');

    return [...box.exposed].map((port) => ({ url: `https://${String(port)}-${id}-p${String(port)}_ab12cd34.${hostname}/`, port, status: 'active' }));
  },
  unexposePort: async (port: number) => {
    box.calls.push('unexposePort');
    box.exposed.delete(port);
  },
  portListeners: async (stamp: string, ports: readonly number[] = [...box.holders.keys()]) => {
    box.calls.push('portListeners');
    expect(stamp).toBe(JOB_STAMP_ENV);

    // As a box that is down answers: nothing was read.
    if (box.down) return null;

    return ports.flatMap((port) => {
      const holder = box.holders.get(port);

      return holder === undefined ? [] : [{ port, pid: 4_000 + port, stamp: holder, command: 'node /workspace/server.js' }];
    });
  },
});

const sandboxes = Object.assign(unreachableObjects<KinuDevbox>("KinuDevbox"), { getByName: sandboxFor });

// Must follow the sandbox double: both helpers' module graphs reach the sandbox SDK.
const { catalogTurn, GATEWAY_CATALOG, jobsOver, makeEnv, orchestratorHarness } = await import('./helpers/actor-harness');

const { TEST_CREDENTIAL_ENCRYPTION_KEY } = await import('./helpers/user-do');

/** What the agent is asked: to stop exposing `port`. */
const withdraw = (port: number): string => `Stop exposing port ${String(port)}.`;

/** The agent withdraws the port its latest ask names from a program; any other turn it answers in words. */
const gateway = stubAiBinding((run) => {
  const { messages } = requestOf(run);
  const asked = messages.reduce((latest, message, index) => (message.role === 'user' ? index : latest), -1);
  const port = [SERVED, SPARE].find((candidate) => JSON.stringify(messages[asked]?.content ?? '').includes(withdraw(candidate)));

  if (port === undefined) return chatCompletion(run, 'Noted.');

  return messages.slice(asked).some((message) => message.role === 'tool')
    ? chatCompletion(run, `Port ${String(port)} is no longer exposed.`)
    : toolCallCompletion(run, { tool: 'eval', args: { code: `return await sandbox.unexposePort(${String(port)});` } }, 'eval_0');
});

/** A workspace whose agent has used its sandbox, with a server job and a build job running. */
async function workspaceWithJobs() {
  const userPlane: RecordedUserPlaneCalls = { warmConnections: [], failWarm: null, titles: [] };
  const world = { container: true, aiGateway: gateway };

  const harnessed = orchestratorHarness(userPlane, world, {
    ...makeEnv(undefined, userPlane, world), KinuDevbox: sandboxes, PREVIEW_HOST_SUFFIX: SUFFIX, CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  });

  harnessed.agent.harnessInstallCatalog(GATEWAY_CATALOG);
  expect(await harnessed.agent.executeInExecutor('sandbox', 'true')).toMatchObject({ exitCode: 0 });
  const jobs = jobsOver(harnessed.db);

  for (const id of ['bgjob-server', 'bgjob-build']) jobs.create({ id, kind: 'shell', workMode: 'build', now: Date.now(), label: id, input: '{}' });

  return { ...harnessed, jobs };
}

/** Each job's status, as the listing reports it. */
async function listed(agent: HarnessOrchestratorAgent): Promise<Record<string, string>> {
  return Object.fromEntries((await agent.listBackgroundJobs()).map((job) => [job.id, job.status]));
}

test('listing jobs asks the box nothing, however often it is read', async () => {
  const { agent } = await workspaceWithJobs();
  box.holders.set(SERVED, 'bgjob-server');
  box.calls = [];

  for (let read = 0; read < 5; read += 1) await agent.listBackgroundJobs();

  expect(box.calls).toEqual([]);
});

test('the listing reports the recorded server as serving, from the record alone', async () => {
  const { agent, jobs } = await workspaceWithJobs();
  jobs.recordServingInWorkspace(new Map([['bgjob-server', SERVED]]));
  box.calls = [];

  expect(await listed(agent)).toEqual({ 'bgjob-server': 'serving', 'bgjob-build': 'running' });
  expect(box.calls).toEqual([]);
  // Reported, not stored: the job still runs, holding the workspace awake as before.
  expect(jobs.get('bgjob-server')).toMatchObject({ status: 'running', serves: SERVED });
});

test('an exposure moving records the running job that holds a port still exposed', async () => {
  const { agent } = await workspaceWithJobs();
  box.holders.set(SERVED, 'bgjob-server');

  await catalogTurn(agent, withdraw(SPARE));

  expect(await listed(agent)).toEqual({ 'bgjob-server': 'serving', 'bgjob-build': 'running' });
});

test('the agent withdrawing the port ends it: nothing serves a port that is no longer exposed', async () => {
  const { agent, jobs } = await workspaceWithJobs();
  box.exposed = new Set([SERVED]);
  box.holders.set(SERVED, 'bgjob-server');
  jobs.recordServingInWorkspace(new Map([['bgjob-server', SERVED]]));
  const heard: string[] = [];
  Reflect.set(agent, 'broadcast', (payload: string) => { heard.push(payload); });

  await catalogTurn(agent, withdraw(SERVED));

  for (const flush of agent.harnessOwedLiveReads.splice(0)) flush();

  expect((await listed(agent))['bgjob-server']).toBe('running');
  // The record moving is what tells a page, or a settle waiting on the room, to read the jobs again.
  expect(heard.flatMap((payload) => {
    const frame = v.safeParse(ReadsFrame, JSON.parse(payload));

    return frame.success ? frame.output.reads : [];
  })).toContain('listBackgroundJobs');
});

test('a box that answers nothing leaves the record standing', async () => {
  const { agent, jobs } = await workspaceWithJobs();
  jobs.recordServingInWorkspace(new Map([['bgjob-server', SERVED]]));
  box.down = true;

  await catalogTurn(agent, withdraw(SPARE));

  expect((await listed(agent))['bgjob-server']).toBe('serving');
});

test('a held port whose holder carries no stamp makes no job serving', async () => {
  const { agent } = await workspaceWithJobs();
  box.holders.set(SERVED, null);

  await catalogTurn(agent, withdraw(SPARE));

  expect((await listed(agent))['bgjob-server']).toBe('running');
});

/** A box that runs any command at once and records the environment each was given. */
function environmentRecordingBox(environments: Array<Readonly<Record<string, string>> | undefined>): KinuDevbox {
  return Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    execUntimed: async (_command: string, options: { readonly env?: Readonly<Record<string, string>> }) => {
      environments.push(options.env);

      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
}

test("the command a sandbox job runs carries the job's id to the container", async () => {
  const environments: Array<Readonly<Record<string, string>> | undefined> = [];
  // `null`: an exec-only box publishes no previews.
  const lane = adaptCloudflareSandbox(environmentRecordingBox(environments), async () => {}, null);

  await lane.exec('node server.js', { env: { [JOB_STAMP_ENV]: 'bgjob-server' } });

  expect(environments).toEqual([{ [JOB_STAMP_ENV]: 'bgjob-server' }]);
});
