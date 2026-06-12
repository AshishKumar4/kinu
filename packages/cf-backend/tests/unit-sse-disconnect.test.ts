// Regression test: the run-events SSE stream must stop polling the agent DO
// as soon as the client goes away (request abort or stream cancellation)
// instead of polling every 500ms for up to 5 minutes.
import { describe, test, expect, mock } from 'bun:test';

mock.module('agents', () => ({
  getAgentByName: async (ns: DurableObjectNamespace, name: string) => ns.get(ns.idFromName(name)),
}));
const { handleRunEventsRequest } = await import('../src/run-events-routes.js');

function sseEnv() {
  let polls = 0;
  const stub = {
    async setName() {},
    async getRunEvents() { polls += 1; return []; },
  };
  const env = {
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => stub },
  } as unknown as Env;
  return { env, pollCount: () => polls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('run-events SSE client disconnect', () => {
  test('aborting the request stops the DO poll loop', async () => {
    const { env, pollCount } = sseEnv();
    const aborter = new AbortController();
    const res = await handleRunEventsRequest(new Request(
      'https://proteus.example.com/api/agents/jarvis/runs/run-1/stream',
      { signal: aborter.signal },
    ), env);
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('text/event-stream');
    // No wildcard CORS on this cookie-authenticated route.
    expect(res?.headers.get('access-control-allow-origin')).toBeNull();

    await sleep(1200); // let a couple of poll iterations happen
    expect(pollCount()).toBeGreaterThanOrEqual(2);

    aborter.abort();
    await sleep(600); // one poll interval to observe the abort
    const after = pollCount();
    await sleep(1200);
    expect(pollCount()).toBe(after); // loop is dead — no further DO requests
  });

  test('cancelling the response stream stops the DO poll loop', async () => {
    const { env, pollCount } = sseEnv();
    const res = await handleRunEventsRequest(new Request(
      'https://proteus.example.com/api/agents/jarvis/runs/run-1/stream',
    ), env);
    const reader = res!.body!.getReader();
    await sleep(1200);
    expect(pollCount()).toBeGreaterThanOrEqual(2);

    await reader.cancel();
    await sleep(600);
    const after = pollCount();
    await sleep(1200);
    expect(pollCount()).toBe(after);
  });
});
