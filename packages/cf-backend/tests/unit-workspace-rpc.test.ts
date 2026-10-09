// The native lifetime is proved by the Tail oracle; these tests cover rejection identity and ownership at the adapter.
import { expect, test } from 'bun:test';
import { KinuError } from '@kinu.run/core/obs';
import { workspaceClient, type AgentWorkspaceCalls } from '../src/agent-facet/workspace-rpc';

function unused(): never {
  throw new Error('the adapter called an unrelated workspace method');
}

const unusedWorkspace: AgentWorkspaceCalls = {
  session: unused,
  stateSession: unused,
  memory: unused,
  program: unused,
  traceTurn: unused,
  traceStream: unused,
  resume: unused,
  guard: unused,
  debit: unused,
  prepareTurn: unused,
  bindProfile: unused,
  prepareChat: unused,
  chatEvent: unused,
  turnEnded: unused,
  owedReport: unused,
  parentReport: unused,
  autoTitle: unused,
  hireAdvisor: unused,
  owes: unused,
  birthContext: unused,
  steerSkills: unused,
  advise: unused,
  enqueueTurn: unused,
  executeTool: unused,
  observe: unused,
  paceStep: unused,
  answerMetadata: unused,
  getAuth: unused,
  listCredentials: unused,
  relayDevice: unused,
  relayModelCall: unused,
  cancelModelRelay: unused,
  sayToParent: unused,
  reportModelCall: unused,
  reportModelOperation: unused,
};

test('a rejected outgoing promise releases its pipeline and preserves the exact rejection', async () => {
  for (const failure of [new KinuError('missing', 'retired'), new Error('transport refused')]) {
    let disposed = 0;
    const pending = Object.assign(Promise.reject(failure), { [Symbol.dispose]: () => { disposed += 1; } });
    const workspace = workspaceClient({ ...unusedWorkspace, paceStep: () => pending });

    await expect(workspace.paceStep('turn')).rejects.toBe(failure);
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
  const workspace = workspaceClient({ ...unusedWorkspace, relayModelCall: () => pending });
  const answered = await workspace.relayModelCall('device', 'call', new Request('http://relay.invalid/'));

  expect(answered).toBe(response);
  expect(new Uint8Array(await answered.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
  expect(disposed).toBe(0);
});

test('an in-process promise has no remote pipeline but keeps its rejection unchanged', async () => {
  const failure = new KinuError('denied', 'local refusal');
  const workspace = workspaceClient({ ...unusedWorkspace, getAuth: () => Promise.reject(failure) });

  await expect(workspace.getAuth('credential')).rejects.toBe(failure);
});
