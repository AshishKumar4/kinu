/**
 * An agent's isolate is a Dynamic Worker, whose console no log store sees (#65): its tail writes each invocation's lines
 * again as the workspace's, the agent named, then the invocation's outcome, CPU and wall time.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { createLineLogger, relayedLine } from '@kinu.run/core/obs';
import { AgentIsolateTail } from '../src/agent-facets';
import { makeEnv } from './helpers/actor-harness';
import { workerContext } from './helpers/bindings';

const console$ = spyOn(console, 'error');

afterEach(() => { console$.mockClear(); });

/** One invocation of an agent's isolate as the platform's tail delivers it: a `jsrpc` call, its console, its exceptions. */
function invocation(logs: TraceLog[], exceptions: TraceException[] = [], outcome = 'ok'): TraceItem {
  return {
    event: { rpcMethod: 'admit' }, eventTimestamp: 1_000, logs, exceptions, diagnosticsChannelEvents: [], scriptName: null,
    entrypoint: 'AgentFacet', outcome, executionModel: 'durableObject', truncated: false, cpuTime: 12, wallTime: 340,
  };
}

test("an agent's isolate's lines are written as the workspace's, the agent named, then its invocation", async () => {
  const written: string[] = [];
  // What the isolate's own diagnostics wrote on its console.
  createLineLogger((line) => { written.push(line); }).event('provider.stream_opened', { provider: 'openai-compat:cmp', ms: 71 });
  const tail = new AgentIsolateTail({ ...workerContext(), props: { workspace: 'acme', actor: 'agent-1', object: 'acme-object' } }, makeEnv());

  console$.mockClear();
  await tail.tail([invocation([
    { timestamp: 1_001, level: 'error', message: [written[0]] },
    { timestamp: 1_002, level: 'log', message: ['a library said', 3] },
  ], [{ timestamp: 1_003, name: 'TypeError', message: 'x is not a function' }])]);

  // The workspace's console, read back as any line in the envelope is.
  const lines = console$.mock.calls.map(([line]) => (typeof line === 'string' ? relayedLine(line) : null)).filter((line) => line?.event !== 'analytics.sink_installed');

  expect(lines).toEqual([
    { event: 'provider.stream_opened', fields: { provider: 'openai-compat:cmp', ms: 71, workspace: 'acme', actor: 'agent-1', object: 'acme-object' } },
    { event: 'agent.isolate_console', fields: { workspace: 'acme', actor: 'agent-1', object: 'acme-object', level: 'log', text: 'a library said 3' } },
    { event: 'agent.isolate_exception', code: 'unavailable', cause: expect.stringContaining('x is not a function'), fields: { workspace: 'acme', actor: 'agent-1', object: 'acme-object' } },
    {
      event: 'agent.isolate_invocation',
      fields: {
        workspace: 'acme', actor: 'agent-1', object: 'acme-object', entrypoint: 'AgentFacet', kind: 'jsrpc', method: 'admit', outcome: 'ok', startedAt: 1_000, cpuMs: 12, wallMs: 340,
        truncated: false,
      },
    },
  ]);
});

test("an isolate the platform ran out of memory is told to its workspace, with when it died; any other end is not", async () => {
  const told: [string, number][] = [];
  const env = makeEnv();

  // The workspace's object, as the tail reaches it by the id its props carry.
  Object.assign(env, {
    OrchestratorAgent: {
      idFromString: (id: string) => id,
      get: () => ({ isolateOutOfMemory: async (actor: string, diedAt: number) => { told.push([actor, diedAt]); } }),
    },
  });
  const tail = new AgentIsolateTail({ ...workerContext(), props: { workspace: 'acme', actor: 'agent-1', object: 'acme-object' } }, env);

  await tail.tail([
    invocation([], [], 'exceededMemory'),
    invocation([], [{ timestamp: 1_300, name: 'Error', message: 'Worker exceeded memory limit.' }], 'exception'),
    invocation([], [{ timestamp: 1_300, name: 'TypeError', message: 'x is not a function' }], 'exception'),
    invocation([]),
  ]);

  expect(told).toEqual([['agent-1', 1_340], ['agent-1', 1_340]]);
});
