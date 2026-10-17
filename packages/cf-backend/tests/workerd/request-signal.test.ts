/**
 * 2026-10-17: a desktop that never connected was closed and its check was never ended, because `request.signal` only
 * aborts on a client leaving under `enable_request_signal`, and the Worker did not set it. Every route that ends work
 * on its caller leaving relies on it: the terminal and desktop attach, a run's event stream, the model proxies.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('a client going away aborts the request the Worker forwarded to a Durable Object', async () => {
  const name = `left-${crypto.randomUUID()}`;
  const probe = env.REQUEST_SIGNAL_PROBE.getByName(name);
  const leaving = new AbortController();
  const asked = Promise.allSettled([env.REQUEST_SIGNAL_ENTRY.fetch(`https://probe.test/hold?name=${name}`, { signal: leaving.signal })]);

  await probe.started();
  leaving.abort();
  // The client's own call ends with its abort, as a page's does when it leaves.
  expect((await asked)[0]?.status).toBe('rejected');

  await expect(probe.aborted()).resolves.toBeUndefined();
});
