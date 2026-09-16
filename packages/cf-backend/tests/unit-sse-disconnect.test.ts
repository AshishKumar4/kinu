// Regression test: the run-events SSE stream must stop polling the agent DO
// as soon as the client goes away (request abort or stream cancellation)
// instead of polling every 500ms for up to 5 minutes.
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';
import { describe, test, expect } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { AwaitedList } from '@kinu.run/test-utils';
import type { SsePacing } from '../src/run-events-routes';

mockAgentsSdk();

const { handleRunEventsRequest } = await import('../src/run-events-routes');

function sseEnv(wire: () => string = () => '[]') {
  // Every DO read the stream makes, as an event the test can await.
  const polled = new AwaitedList<number>();

  const stub = {
    async getRunEventsWire() {
      polled.push(polled.items.length + 1);

      return wire();
    },
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

  return { env, pollCount: () => polled.items.length, polled: (count: number) => polled.until((items) => items.length >= count) };
}

/**
 * The stream's pacing, driven by hand (D19): each poll interval is a wait the
 * test releases with `tick`, so "a couple of poll iterations" is two releases
 * and "no further DO request" is a release nobody polls after.
 */
function handPacing(): SsePacing & { tick(): void } {
  let parked: (() => void) | undefined;
  // A tick issued before the loop reaches its next wait releases that wait
  // when it arrives: the test's continuation runs before the loop's after
  // a DO read, so the order of the two is not the test's to assume.
  let owed = 0;

  return {
    now: () => 0,
    wait: () => {
      if (owed > 0) {
        owed -= 1;

        return Promise.resolve();
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      parked = resolve;

      return promise;
    },
    tick: () => {
      if (parked === undefined) {
        owed += 1;

        return;
      }

      parked();
      parked = undefined;
    },
  };
}

describe('run-events SSE client disconnect', () => {
  test('aborting the request stops the DO poll loop', async () => {
    const { env, pollCount, polled } = sseEnv();
    const aborter = new AbortController();
    const pacing = handPacing();

    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
      { signal: aborter.signal },
    ), env, pacing);

    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('text/event-stream');
    // No wildcard CORS on this cookie-authenticated route.
    expect(res?.headers.get('access-control-allow-origin')).toBeNull();

    // The replay, then two poll iterations, each released by hand and each
    // awaited on the DO read it makes.
    await polled(1);
    pacing.tick();
    await polled(2);
    pacing.tick();
    await polled(3);

    aborter.abort();
    // The loop is parked on its wait; releasing it after the abort must end
    // it without another DO read, so a read here could only come from a loop
    // that missed the abort.
    const after = pollCount();
    pacing.tick();
    await res?.body?.cancel();
    expect(pollCount()).toBe(after); // loop is dead — no further DO requests
  });

  test('cancelling the response stream stops the DO poll loop', async () => {
    const { env, pollCount, polled } = sseEnv();
    const pacing = handPacing();

    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), env, pacing);

    if (!res?.body) throw new Error('Expected an SSE response body');
    const reader = res.body.getReader();
    await polled(1);
    pacing.tick();
    await polled(2);
    pacing.tick();
    await polled(3);

    await reader.cancel();
    const after = pollCount();
    pacing.tick();
    expect(pollCount()).toBe(after);
  });

  test('a run that already ended closes after the replay instead of polling dead reads', async () => {
    // The poll loop tests only batches it fetched itself, so a run_end in the
    // initial replay misses that test: without the close below, a finished run
    // holds the stream open and polls the DO every 500 ms until the timeout.
    const { env, pollCount } = sseEnv(() => JSON.stringify([{
      eventIndex: 3, runId: 'run-1', type: 'run_end', timestamp: new Date(0).toISOString(),
    }]));

    // A stream that polled instead of closing would never reach `done`, and
    // the hand pacing never releases a wait here: that hang is the failure,
    // ended by the ladder at the gate's deadline rather than by a clock beside
    // the stream.
    const res = await handleRunEventsRequest(new Request(
      'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    ), env, handPacing());

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
