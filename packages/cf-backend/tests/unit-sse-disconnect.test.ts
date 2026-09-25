// Defends: the run-events SSE stream must stop polling the agent DO once the client aborts
// or cancels.
import type { RunEventsTarget } from '../src/run-events-routes';
import { serveFamily } from './helpers/api';
import type { StoredRunEvent } from '@kinu.run/core';
import { describe, test, expect } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { AwaitedList, handClock } from '@kinu.run/test-utils';

mockAgentsSdk();

const { runEventsRoutes } = await import('../src/run-events-routes');

/** The run's end as the ledger stores it. */
const RUN_END: StoredRunEvent = {
  eventIndex: 3,
  type: 'run_end',
  payload: JSON.stringify({ eventIndex: 3, runId: 'run-1', type: 'run_end', timestamp: new Date(0).toISOString() }),
};

function sseStream(answer: (read: number) => StoredRunEvent[] = () => []) {
  const polled = new AwaitedList<number>();

  const stub: RunEventsTarget = {
    listRuns: () => { throw new Error('OrchestratorAgent.listRuns: not reachable in this test'); },
    async getRunEventText() {
      polled.push(polled.items.length + 1);

      return answer(polled.items.length);
    },
  };

  return {
    resolveAgent: () => Promise.resolve(stub),
    pollCount: () => polled.items.length,
    polled: (count: number) => polled.until((items) => items.length >= count),
  };
}

describe('run-events SSE client disconnect', () => {
  test('aborting the request stops the DO poll loop', async () => {
    // The fourth read answers run_end, so a missed abort ends the stream visibly instead of
    // hanging.
    const { resolveAgent, pollCount, polled } = sseStream((read) => read < 4 ? [] : [RUN_END]);

    const aborter = new AbortController();
    const clock = handClock();

    const res = await serveFamily(runEventsRoutes(clock, () => resolveAgent), { workspace: { name: 'jarvis' } })(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
      { signal: aborter.signal },
    ), {});

    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('text/event-stream');
    // No wildcard CORS on this cookie-authenticated route.
    expect(res?.headers.get('access-control-allow-origin')).toBeNull();

    await polled(1);
    await clock.whenArmed(1);
    clock.tick();
    await polled(2);
    await clock.whenArmed(2);
    clock.tick();
    await polled(3);

    aborter.abort();
    // Await the stream's own end, never cancel() from here: that would end the loop whether or
    // not it saw the abort.
    const after = pollCount();

    if (!res?.body) throw new Error('Expected an SSE response body');
    const text = new Response(res.body).text();

    const released = clock.whenArmed(3).then(() => {
      clock.tick();

      return text;
    });

    const body = await Promise.race([text, released]);
    expect(pollCount()).toBe(after);
    expect(body).not.toContain('run_end');
    expect(clock.armed()).toBe(0);
  });

  test('cancelling the response stream stops the DO poll loop', async () => {
    const { resolveAgent, pollCount, polled } = sseStream();
    const clock = handClock();

    const res = await serveFamily(runEventsRoutes(clock, () => resolveAgent), { workspace: { name: 'jarvis' } })(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), {});

    if (!res?.body) throw new Error('Expected an SSE response body');
    const reader = res.body.getReader();
    await polled(1);
    await clock.whenArmed(1);
    clock.tick();
    await polled(2);
    await clock.whenArmed(2);
    clock.tick();
    await polled(3);

    await reader.cancel();
    // The armed-wait count tells a loop that saw the cancel from one parked on a third wait.
    const after = pollCount();
    expect(clock.armed()).toBe(0);
    expect(pollCount()).toBe(after);
  });

  test('a run that already ended closes after the replay instead of polling dead reads', async () => {
    // A run_end in the initial replay bypasses the poll loop's check: without the close below the
    // stream keeps polling until the timeout.
    const { resolveAgent, pollCount } = sseStream(() => [RUN_END]);

    // A stream that polled instead of closing never reaches `done`: the hang is the failure.
    const res = await serveFamily(runEventsRoutes(handClock(), () => resolveAgent), { workspace: { name: 'jarvis' } })(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), {});

    if (!res?.body) throw new Error('Expected an SSE response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let finished = false;

    for (;;) {
      const next = await reader.read();

      if (next.done) { finished = true; break; }

      body += decoder.decode(next.value, { stream: true });
    }

    await reader.cancel();
    expect(body).toContain('run_end');
    expect(finished).toBe(true);
    expect(pollCount()).toBe(1);
  });
});
