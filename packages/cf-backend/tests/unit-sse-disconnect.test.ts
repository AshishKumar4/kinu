// Regression test: the run-events SSE stream must stop polling the agent DO
// as soon as the client goes away (request abort or stream cancellation)
// instead of polling every 500ms for up to 5 minutes.
import type { RunEventsTarget } from '../src/run-events-routes';
import { describe, test, expect } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { AwaitedList, handClock } from '@kinu.run/test-utils';

mockAgentsSdk();

const { handleRunEventsRequest } = await import('../src/run-events-routes');

function sseStream(wire: (read: number) => string = () => '[]') {
  // Every DO read the stream makes, as an event the test can await.
  const polled = new AwaitedList<number>();

  const stub: RunEventsTarget = {
    listRuns: () => { throw new Error('OrchestratorAgent.listRuns: not reachable in this test'); },
    async getRunEventsWire() {
      polled.push(polled.items.length + 1);

      return wire(polled.items.length);
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
    // The fourth DO read — the one only a loop that missed the abort makes —
    // answers run_end, so a missed abort ENDS the stream with one extra read
    // and a run_end in the body instead of hanging: both are red below.
    const { resolveAgent, pollCount, polled } = sseStream((read) => read < 4 ? '[]' : JSON.stringify([{
      eventIndex: 3, runId: 'run-1', type: 'run_end', timestamp: new Date(0).toISOString(),
    }]));

    const aborter = new AbortController();
    const clock = handClock();

    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
      { signal: aborter.signal },
    ), resolveAgent, clock);

    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('text/event-stream');
    // No wildcard CORS on this cookie-authenticated route.
    expect(res?.headers.get('access-control-allow-origin')).toBeNull();

    // The replay, then two poll iterations, each released by hand and each
    // awaited on the DO read it makes.
    await polled(1);
    await clock.whenArmed(1);
    clock.tick();
    await polled(2);
    await clock.whenArmed(2);
    clock.tick();
    await polled(3);

    aborter.abort();
    // The abort lands before the third read returns (`polled` resolves at the
    // read, not its answer), so a loop that saw it ends at its next check and
    // arms no further wait. A loop that MISSED it parks on a third wait; that
    // wait is released so the miss shows as a fourth read and a run_end in
    // the body. The stream's own end is what is awaited — never a cancel()
    // from here, which would end the loop whether or not it saw the abort.
    const after = pollCount();

    if (!res?.body) throw new Error('Expected an SSE response body');
    const text = new Response(res.body).text();

    const released = clock.whenArmed(3).then(() => {
      clock.tick();

      return text;
    });

    const body = await Promise.race([text, released]);
    expect(pollCount()).toBe(after); // loop is dead — no further DO requests
    expect(body).not.toContain('run_end');
    expect(clock.armed()).toBe(0);    // and it armed no wait after the abort
  });

  test('cancelling the response stream stops the DO poll loop', async () => {
    const { resolveAgent, pollCount, polled } = sseStream();
    const clock = handClock();

    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), resolveAgent, clock);

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
    // The cancel lands before the third read returns, so a loop that saw it
    // ends at its next check with no wait armed; one that missed it is parked
    // on a third wait — the armed count is the read that tells them apart.
    const after = pollCount();
    expect(clock.armed()).toBe(0);
    expect(pollCount()).toBe(after);
  });

  test('a run that already ended closes after the replay instead of polling dead reads', async () => {
    // The poll loop tests only batches it fetched itself, so a run_end in the
    // initial replay misses that test: without the close below, a finished run
    // holds the stream open and polls the DO every 500 ms until the timeout.
    const { resolveAgent, pollCount } = sseStream(() => JSON.stringify([{
      eventIndex: 3, runId: 'run-1', type: 'run_end', timestamp: new Date(0).toISOString(),
    }]));

    // A stream that polled instead of closing would never reach `done`, and
    // the hand pacing never releases a wait here: that hang is the failure,
    // ended by the ladder at the gate's deadline rather than by a clock beside
    // the stream.
    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), resolveAgent, handClock());

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
    expect(body).toContain('run_end'); // the replay still reaches the reader
    expect(finished).toBe(true); // the stream ended instead of polling dead reads
    expect(pollCount()).toBe(1);
  });
});
