import { afterEach, describe, expect, test } from 'bun:test';
import { limitEgress, type Egress } from './omp-egress';

let egress: Egress | null = null;

afterEach(() => {
  egress?.stop();
  egress = null;
});

describe("a measured run's egress", () => {
  test('a fetch to a host not allowed is refused, plain or tunnelled, and named', async () => {
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reached') });

    try {
      egress = limitEgress(['api.cloudflare.com:443']);
      const asked = await fetch(`http://127.0.0.1:${String(upstream.port)}/`).then((response) => response.status);
      const tunnelled = await fetch('https://example.com/').then(() => 'reached', () => 'refused');

      expect({ asked, tunnelled }).toEqual({ asked: 403, tunnelled: 'refused' });
      expect(egress.refused).toEqual([`GET http://127.0.0.1:${String(upstream.port)}/ HTTP/1.1`, 'example.com:443']);
    } finally {
      await upstream.stop(true);
    }
  });

  test('stopping it restores the proxy settings it found', () => {
    const before = process.env.HTTPS_PROXY;
    limitEgress([]).stop();

    expect(process.env.HTTPS_PROXY).toBe(before);
  });
});
