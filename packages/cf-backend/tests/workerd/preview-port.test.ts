import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('a served port from the hosted workspace', () => {
  const open = (name: string) => env.PREVIEW_PORT_PROBE.get(env.PREVIEW_PORT_PROBE.idFromName(name));

  it('a user-invoked program runs past the old 30 s wall-clock lifetime and reports its own exit', async () => {
    const subject = open('outlast');

    // Measured 2026-09-15 under workerd, @nimbus-sh/worker 0.7.0: `sleep 33 && echo outlasted`
    // exits 0 where worker 0.6 killed it at its wall-clock cap.
    const ran = await subject.outlast(33);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain('outlasted');
  });

  it('answers a loopback fetch with served bytes or a classified refusal, never a bare 1003', async () => {
    const subject = open('loopback');

    // A host-registered virtual server: `curl` must answer with its bytes, not fall through to
    // the platform `fetch`.
    const served = await subject.serveLoopback(8789, 'Kinu live preview 2026-09-05');
    expect(served.registered).toBe(true);
    const hit = await subject.curlLoopback(8789);
    const hitCombined = `${hit.stdout}\n${hit.stderr}`;
    // Red (staging 2cba97705, workerd): the body carried "error code: 1003", the edge's page.
    expect(hitCombined).not.toContain('1003');
    expect(hit.exitCode).toBe(0);
    expect(hit.stdout).toContain('Kinu live preview 2026-09-05');

    // Nothing listening: a classified refusal (curl exit 7), never the edge's page.
    await subject.unserveLoopback(8789);
    const missed = await subject.curlLoopback(8789);
    expect(missed.exitCode).toBe(7);
    expect(`${missed.stdout}\n${missed.stderr}`).not.toContain('1003');
  });
});
