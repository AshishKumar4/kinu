// Regression test: the run-events SSE stream must stop polling the agent DO
// as soon as the client goes away (request abort or stream cancellation)
// instead of polling every 500ms for up to 5 minutes.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';

mockAgentsSdk();
const { handleRunEventsRequest } = await import('../src/run-events-routes');

function sseEnv(wire: () => string = () => '[]') {
  let polls = 0;
  const stub = {
    async setName() {},
    async getRunEventsWire() { polls += 1; return wire(); },
  };
  const bindings = {
    OrchestratorAgent: { idFromName: (n: string) => n, get: () => stub },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
  };
  const partialEnv: Partial<Env> = {};
  Object.assign(partialEnv, bindings);
  // SAFETY: the SSE route only reaches the locally constructed orchestrator
  // namespace and credential secret in this suite.
  const env = partialEnv as Env;
  return { env, pollCount: () => polls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('run-events SSE client disconnect', () => {
  test('aborting the request stops the DO poll loop', async () => {
    const { env, pollCount } = sseEnv();
    const aborter = new AbortController();
    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
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
  // Measured 3.0 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);

  test('cancelling the response stream stops the DO poll loop', async () => {
    const { env, pollCount } = sseEnv();
    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), env);
    if (!res?.body) throw new Error('Expected an SSE response body');
    const reader = res.body.getReader();
    await sleep(1200);
    expect(pollCount()).toBeGreaterThanOrEqual(2);

    await reader.cancel();
    await sleep(600);
    const after = pollCount();
    await sleep(1200);
    expect(pollCount()).toBe(after);
  // Measured 3.0 s on a box at load 66-98 (2026-09-02 sweep, foreign mutation jobs on all
  // 24 threads), where bun's default 5 s bound read red and the test is green alone. A bound
  // on a finite run, stated with its measurement, not a detector.
  }, 15_000);

  test('a run that already ended closes after the replay instead of polling dead reads', async () => {
    // The poll loop tests only batches it fetched itself, so a run_end in the
    // initial replay misses that test: without the close below, a finished run
    // holds the stream open and polls the DO every 500 ms until the timeout.
    const { env, pollCount } = sseEnv(() => JSON.stringify([{
      eventIndex: 3, runId: 'run-1', type: 'run_end', timestamp: new Date(0).toISOString(),
    }]));
    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), env);
    if (!res?.body) throw new Error('Expected an SSE response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let finished = false;
    const deadline = sleep(3000).then((): 'timed-out' => 'timed-out');
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timed-out') break;
      if (next.done) { finished = true; break; }
      body += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel();
    expect(body).toContain('run_end'); // the replay still reaches the reader
    expect(finished).toBe(true); // the stream ended instead of polling dead reads
    expect(pollCount()).toBe(1);
  }, 15_000);
});
