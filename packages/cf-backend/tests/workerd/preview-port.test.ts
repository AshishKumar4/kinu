import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('a served port from the hosted workspace', () => {
  const open = (name: string) => env.PREVIEW_PORT_PROBE.get(env.PREVIEW_PORT_PROBE.idFromName(name));

  it('refuses node with a reason naming the container, not the raw V8 error alone', async () => {
    const subject = open('node-refusal');

    const evaluated = await subject.nodeEval();
    const filed = await subject.nodeFile();
    expect(evaluated.exitCode).toBe(127);
    expect(filed.exitCode).toBe(127);
    expect(evaluated.stderr).toContain('sandbox');
    expect(filed.stderr).toContain('sandbox');
  });

  it('answers a loopback fetch with served bytes or a classified refusal, never a bare 1003', async () => {
    const subject = open('loopback');

    // A virtual server the host registered with no compilation. `curl` must
    // answer with its bytes: today the library `curl` loads with no kernel,
    // skips the virtual check, and falls through to the platform `fetch`.
    const served = await subject.serveLoopback(8789, 'Kinu live preview 2026-09-05');
    expect(served.registered).toBe(true);
    const hit = await subject.curlLoopback(8789);
    const hitCombined = `${hit.stdout}\n${hit.stderr}`;
    // RED QUOTE (staging b04c01d31, workerd): the body carried
    // "error code: 1003" — the edge's page for a request that never reached
    // any virtual server.
    expect(hitCombined).not.toContain('1003');
    expect(hit.exitCode).toBe(0);
    expect(hit.stdout).toContain('Kinu live preview 2026-09-05');

    // With nothing listening, the same fetch is a classified refusal (curl's
    // own exit 7), still never the edge's page.
    await subject.unserveLoopback(8789);
    const missed = await subject.curlLoopback(8789);
    expect(missed.exitCode).toBe(7);
    expect(`${missed.stdout}\n${missed.stderr}`).not.toContain('1003');
  });
});
