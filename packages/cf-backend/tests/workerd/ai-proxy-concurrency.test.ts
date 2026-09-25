/**
 * Concurrent requests to the CLI AI proxy (`POST /api/user/ai/v1/chat/completions`) through the production Worker entry,
 * on the eval identity's direct Workers AI lane that CLI swarm nodes and parallel subagents share.
 *
 * Workers bounds connections per request, not per isolate: "Each Worker invocation can have up to six connections
 * simultaneously waiting for response headers", and the runtime queues the seventh itself
 * (https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections, read 2026-09-23; catalog
 * `worker.simultaneous_connections`). The provider pacer spent that six as one budget for the whole isolate.
 * Measured on kinu.run at 6c3b99cfb, 2026-09-23T03:43:51Z: eight concurrent requests answered 6x200 and 2x HTTP 500
 * `error code: 1101`, each 56-58 ms after it arrived, and Workers Logs names both "The Workers runtime canceled this
 * request because it detected that your Worker's code had hung": a request queued for the budget waits on a promise
 * only another request can resolve. A request the runtime cancels while it holds budget (a client that disconnects
 * mid-inference) never gives it back. The 03:27Z run drew 2x200 and 6x1101 from eight; the four units it lacked match
 * four requests their clients abandoned at 02:59Z, each after 182 s with no response.
 *
 * Red at 6c3b99cfb in this pool: 6x200 and 2 hung from eight; 5x200 and 1 hung from six after one cancel, while six
 * with nothing canceled first all answered. `SurfaceAI` parks every `HELD_PROXY_MODEL` call on the Node-side hold, so
 * each request stays out on real I/O until the test releases them all. A request the runtime kills settles at once; a
 * parked one only after release.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { HELD_PROXY_MODEL } from './ai-proxy-shapes';

const PROXY_URL = 'http://localhost/api/user/ai/v1/chat/completions';

/** The per-invocation connection count the pacer spent as its isolate budget. */
const INVOCATION_CONNECTIONS = 6;

/** Two past it, as the production burst was. */
const CONCURRENT = INVOCATION_CONNECTIONS + 2;

const CompletionSchema = v.object({
  choices: v.tuple([v.object({ message: v.object({ content: v.string() }) })]),
});

interface Outcome {
  readonly status: number | 'threw';
  readonly answer: string;
}

const ANSWERED: Outcome = { status: 200, answer: 'held' };

/** A runtime-killed request is the observation, so its rejection is recorded as an outcome rather than thrown. */
async function complete(bearer: string, signal?: AbortSignal): Promise<Outcome> {
  try {
    const response = await env.PUBLIC_SURFACE.fetch(PROXY_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: HELD_PROXY_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
      signal,
    });

    const text = await response.text();

    return response.ok
      ? { status: response.status, answer: v.parse(CompletionSchema, JSON.parse(text)).choices[0].message.content }
      : { status: response.status, answer: text };
  } catch (cause) {
    return { status: 'threw', answer: String(cause) };
  }
}

/** Fires `count` requests, waits until `parked` model calls are out or one request settles first, then releases. */
async function burst(bearer: string, count: number, parked: number): Promise<Outcome[]> {
  const requests = Array.from({ length: count }, () => complete(bearer));
  const allParked = env.SURFACE_CONTROL.proxyModelParked(parked);
  await Promise.race([allParked, ...requests]);
  await env.SURFACE_CONTROL.releaseProxyModel();
  await allParked;

  return Promise.all(requests);
}

describe('CLI AI proxy under concurrent requests from one user', () => {
  it('answers eight concurrent requests, more than one invocation may hold waiting for headers', async () => {
    const bearer = await env.SURFACE_CONTROL.mintCliBearer();
    await env.SURFACE_CONTROL.holdProxyModel();

    const outcomes = await burst(bearer, CONCURRENT, CONCURRENT);

    expect(outcomes).toEqual(Array.from({ length: CONCURRENT }, () => ANSWERED));
  });

  it('serves six concurrent requests after one was canceled with its model call out', async () => {
    const bearer = await env.SURFACE_CONTROL.mintCliBearer();
    await env.SURFACE_CONTROL.holdProxyModel();
    const client = new AbortController();
    const canceled = complete(bearer, client.signal);
    await env.SURFACE_CONTROL.proxyModelParked(1);
    client.abort();
    expect((await canceled).status).toBe('threw');

    // The canceled call stays parked on the Node side, so the count includes it.
    const outcomes = await burst(bearer, INVOCATION_CONNECTIONS, INVOCATION_CONNECTIONS + 1);

    expect(outcomes).toEqual(Array.from({ length: INVOCATION_CONNECTIONS }, () => ANSWERED));
  });
});
