// The native lifetime is proved by the Tail oracle; these tests cover rejection identity and ownership at the adapter.
import { expect, test } from 'bun:test';
import type { Memory } from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import type { NimbusSessionSurface } from '@nimbus-sh/sdk/sandbox';
import { workspaceClient, type AgentWorkspaceCalls, type AgentWorkspacePort } from '../src/agent-facet/workspace-rpc';

function unused(): never {
  throw new Error('the adapter called an unrelated workspace method');
}

const unusedPort: AgentWorkspacePort = {
  traceTurn: unused,
  traceStream: unused,
  resume: unused,
  guard: unused,
  debit: unused,
  prepareTurn: unused,
  prepareChat: unused,
  scaffold: unused,
  chatEvent: unused,
  turnEnded: unused,
  answerAmended: unused,
  turnSettled: unused,
  runSettled: unused,
  turnReport: unused,
  parentReport: unused,
  autoTitle: unused,
  hireAdvisor: unused,
  owes: unused,
  birthContext: unused,
  steerSkills: unused,
  releaseForeground: unused,
  openWork: unused,
  armCacheWarm: unused,
  enqueueTurn: unused,
  executeTool: unused,
  receipts: unused,
  observe: unused,
  paceStep: unused,
  answerMetadata: unused,
  getAuth: unused,
  listCredentials: unused,
  relayDevice: unused,
  relayModelCall: unused,
  cancelModelRelay: unused,
  sayToParent: unused,
  logActivity: unused,
  reportModelCall: unused,
};

const unusedWorkspace: AgentWorkspaceCalls = { session: unused, stateSession: unused, memory: unused, program: unused, port: unused };

/** A workspace whose port answers with `calls`, as its host does. */
function ported(calls: Partial<AgentWorkspacePort>): AgentWorkspaceCalls {
  return { ...unusedWorkspace, port: async () => ({ ...unusedPort, ...calls }) };
}

test('a rejected outgoing promise releases its pipeline and preserves the exact rejection', async () => {
  for (const failure of [new KinuError('missing', 'retired'), new Error('transport refused')]) {
    let disposed = 0;
    const pending = Object.assign(Promise.reject(failure), { [Symbol.dispose]: () => { disposed += 1; } });
    const workspace = workspaceClient(ported({ paceStep: () => pending }));

    await expect(workspace.paceStep({ turnId: 'turn', runId: 'run', epoch: 1 }, null)).rejects.toBe(failure);
    expect(disposed).toBe(1);
  }
});

test('a fulfilled response owns its stream and neither received disposer is released', async () => {
  let disposed = 0;

  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array([0, 128, 255]));
    controller.close();
  } });

  const response = Object.assign(new Response(stream), { [Symbol.dispose]: () => { disposed += 1; } });
  const pending = Object.assign(Promise.resolve(response), { [Symbol.dispose]: () => { disposed += 1; } });
  const workspace = workspaceClient(ported({ relayModelCall: () => pending }));
  const answered = await workspace.relayModelCall('device', 'call', new Request('http://relay.invalid/'));

  expect(answered).toBe(response);
  expect(new Uint8Array(await answered.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
  expect(disposed).toBe(0);
});

test('an in-process promise has no remote pipeline but keeps its rejection unchanged', async () => {
  const failure = new KinuError('denied', 'local refusal');
  const workspace = workspaceClient(ported({ getAuth: () => Promise.reject(failure) }));

  await expect(workspace.getAuth('credential')).rejects.toBe(failure);
});

const tailOnly: Memory = { chunk: unused, write: unused, append: unused, index: unused, search: unused, read: unused, tail: async () => null };

/** A workspace whose every port, session and memory is counted as it is opened and let go (#69). */
function counted(calls: Partial<AgentWorkspacePort>) {
  const tally = { ports: 0, portsLetGo: 0, sessions: 0, sessionsLetGo: 0, memories: 0, memoriesLetGo: 0 };
  const opened = <T>(answer: T, letGo: () => void): Promise<T> => Object.assign(Promise.resolve(answer), { [Symbol.dispose]: letGo });

  const workspace: AgentWorkspaceCalls = {
    ...unusedWorkspace,
    port: () => {
      tally.ports += 1;

      return opened({ ...unusedPort, ...calls }, () => { tally.portsLetGo += 1; });
    },
    session: () => {
      tally.sessions += 1;
      const reads: Pick<NimbusSessionSurface, '_rpcReadFile'> = { _rpcReadFile: async () => 'notes' };

      // SAFETY: the test reads one file through the session, the only member constructed above.
      return opened(reads as NimbusSessionSurface, () => { tally.sessionsLetGo += 1; });
    },
    memory: () => {
      tally.memories += 1;

      return opened(tailOnly, () => { tally.memoriesLetGo += 1; });
    },
  };

  return { tally, workspace };
}

test("a working agent's calls share one port, which is let go once it rests", async () => {
  const { tally, workspace } = counted({ logActivity: async () => {} });
  const client = workspaceClient(workspace);

  client.work();
  await client.logActivity([]);
  await client.logActivity([]);
  expect(tally).toMatchObject({ ports: 1, portsLetGo: 0 });

  client.rest();
  expect(tally).toMatchObject({ ports: 1, portsLetGo: 1 });
});

test('a call while the agent rests opens the port for itself and lets it go at its edge', async () => {
  const { tally, workspace } = counted({ logActivity: async () => {} });
  const client = workspaceClient(workspace);

  await client.logActivity([]);
  await client.logActivity([]);
  expect(tally).toMatchObject({ ports: 2, portsLetGo: 2 });
});

test('an agent that rests with a call on its port lets the port go once that call settles', async () => {
  const answer = Promise.withResolvers<void>();
  const { tally, workspace } = counted({ logActivity: () => answer.promise });
  const client = workspaceClient(workspace);

  client.work();
  const call = client.logActivity([]);

  await Promise.resolve();
  client.rest();
  expect(tally.portsLetGo).toBe(0);
  answer.resolve();
  await call;
  expect(tally).toMatchObject({ ports: 1, portsLetGo: 1 });
});

test("an answer whose body is read after it settles keeps its port until the client is let go", async () => {
  const { tally, workspace } = counted({ relayModelCall: async () => new Response('kept stream') });
  const client = workspaceClient(workspace);
  const answered = await client.relayModelCall('device', 'call', new Request('http://relay.invalid/'));

  expect(tally).toMatchObject({ ports: 1, portsLetGo: 0 });
  expect(await answered.text()).toBe('kept stream');
  client[Symbol.dispose]();
  expect(tally).toMatchObject({ ports: 1, portsLetGo: 1 });
});

test('a session and a memory are each opened for one call and let go once it settles', async () => {
  const { tally, workspace } = counted({});
  const client = workspaceClient(workspace);
  const session = client.session();

  await session._rpcReadFile('/notes.md');
  await session._rpcReadFile('/notes.md');
  await client.memory().tail('/memory.md', 64);
  await client.memory().tail('/memory.md', 64);
  expect(tally).toMatchObject({ sessions: 2, sessionsLetGo: 2, memories: 2, memoriesLetGo: 2 });
});
