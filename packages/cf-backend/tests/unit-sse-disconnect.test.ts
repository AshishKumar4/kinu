// Defends: the run-events SSE stream reads the log only after a write rang the workspace's doorbell, so a follower of
// an idle run reads nothing; it stops asking the agent DO once the client aborts or cancels; and one stream reads a
// bounded number of bytes.
import type { RunEventsTarget, RunWrites as Doorbell } from '../src/run-events-routes';
import { serveFamily } from './helpers/api';
import type { StoredRunEvent } from '@kinu.run/core';
import { describe, test, expect } from 'bun:test';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { AwaitedList, handClock, type HandClock } from '@kinu.run/test-utils';

mockAgentsSdk();

// Loaded after the SDK mock, which a static import would precede.
const { runEventsRoutes, RunWrites } = await import('../src/run-events-routes');

function stored(eventIndex: number, type: string, extra = ''): StoredRunEvent {
  return { eventIndex, type, payload: JSON.stringify({ eventIndex, runId: 'run-1', type, timestamp: new Date(0).toISOString(), extra }) };
}

/** The run's end as the ledger stores it. */
const RUN_END = stored(3, 'run_end');

/** The workspace object as the route reaches it: its log answers `answer(read)` to the read-th read, and its doorbell
 *  is the object's own, on the test's clock. */
function workspaceOver(clock: HandClock, answer: (read: number) => StoredRunEvent[] = () => []) {
  const reads = new AwaitedList<number>();
  const writes = new RunWrites(clock);

  const agent: RunEventsTarget = {
    listRuns: () => { throw new Error('OrchestratorAgent.listRuns: not reachable in this test'); },
    async getRunEventText() {
      reads.push(reads.items.length + 1);

      return answer(reads.items.length);
    },
    awaitRunWrites: async (seen, ms) => await writes.after(seen, ms),
  };

  return {
    agent,
    writes,
    readCount: () => reads.items.length,
    read: (count: number) => reads.until((items) => items.length >= count),
  };
}

async function follow(agent: RunEventsTarget, clock: HandClock, signal?: AbortSignal): Promise<{ readonly res: Response; readonly body: ReadableStream<Uint8Array> }> {
  const res = await serveFamily(runEventsRoutes(clock), { workspace: { name: 'jarvis', agent } })(new Request(
    'https://kinu.example.com/api/workspaces/jarvis/runs/run-1/stream',
    signal === undefined ? {} : { signal },
  ), {});

  if (res?.body == null) throw new Error('Expected an SSE response body');

  return { res, body: res.body };
}

/** What the stream wrote until it ended. */
async function drained(body: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(body).text();
}

describe('run-events SSE stream', () => {
  test('a follower of an idle run reads nothing until a write rings, then reads it at once', async () => {
    const clock = handClock();
    // The first read is the replay; the next answers the write the ring announces.
    const { agent, writes, readCount, read } = workspaceOver(clock, (count) => (count === 2 ? [stored(0, 'turn_start'), RUN_END] : []));
    const { res, body: stream } = await follow(agent, clock);

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // No wildcard CORS on this cookie-authenticated route.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await read(1);

    // A minute of an idle run: four heartbeats, and not one read of the log.
    for (let armed = 1; armed <= 4; armed++) {
      await clock.whenArmed(armed);
      clock.tick();
    }

    await clock.whenArmed(5);
    expect(readCount()).toBe(1);

    writes.ring();
    const body = await drained(stream);

    expect(readCount()).toBe(2);
    expect(body.match(/:heartbeat/gu)?.length).toBe(4);
    expect(body).toContain('event: run_end');
    expect(clock.armed()).toBe(0);
  });

  test('a write made while a page is read wakes the next wait at once', async () => {
    const clock = handClock();
    let landed: Doorbell | undefined;

    // The replay's own read is when the write lands: after the count the stream holds, before it waits.
    const { agent, writes, readCount } = workspaceOver(clock, (count) => {
      if (count === 1) landed?.ring();

      return count === 2 ? [RUN_END] : [];
    });

    landed = writes;
    const body = await drained((await follow(agent, clock)).body);

    expect(readCount()).toBe(2);
    expect(body).toContain('event: run_end');
    expect(clock.armed()).toBe(0);
  });

  test('aborting the request stops asking the DO', async () => {
    const clock = handClock();
    const { agent, readCount, read } = workspaceOver(clock);
    const aborter = new AbortController();
    const { body: stream } = await follow(agent, clock, aborter.signal);

    await read(1);
    await clock.whenArmed(1);
    aborter.abort();
    // The wait it is in ends at its heartbeat; the abort ends the stream there, before another read or wait.
    clock.tick();
    const body = await drained(stream);

    expect(readCount()).toBe(1);
    expect(body).not.toContain(':heartbeat');
    expect(clock.armed()).toBe(0);
  });

  test('cancelling the response stream stops asking the DO', async () => {
    const clock = handClock();
    const { agent, readCount, read } = workspaceOver(clock);
    const reader = (await follow(agent, clock)).body.getReader();

    await read(1);
    await clock.whenArmed(1);
    await reader.cancel();
    clock.tick();
    await Promise.resolve();

    expect(readCount()).toBe(1);
    expect(clock.armed()).toBe(0);
  });

  test('a run that already ended closes after the replay', async () => {
    const clock = handClock();
    const { agent, readCount } = workspaceOver(clock, () => [RUN_END]);
    const body = await drained((await follow(agent, clock)).body);

    expect(body).toContain('run_end');
    expect(readCount()).toBe(1);
    expect(clock.armed()).toBe(0);
  });

  test('one stream reads a bounded number of bytes, and the client resumes from its last id', async () => {
    const clock = handClock();
    const MiB = 'x'.repeat(1024 * 1024);
    // A run whose log never runs dry: every read answers a 1 MiB event.
    const { agent, readCount } = workspaceOver(clock, (count) => [stored(count - 1, 'tool_call_end', MiB)]);
    const body = await drained((await follow(agent, clock)).body);
    const ids = [...body.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));

    expect(readCount()).toBe(8);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
