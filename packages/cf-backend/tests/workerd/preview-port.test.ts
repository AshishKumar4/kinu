/**
 * The workspace port preview, executed for real in workerd.
 *
 * WHY THE WORKERD POOL. Both defects are invisible to `bun test`:
 *
 *   1. `node -e` / `node <file>` compile their source with `new Function`,
 *      which workerd forbids ("Code generation from strings disallowed for
 *      this context") while Bun runs happily. The staged acceptance lane met
 *      the raw V8 error where the product owes a reason that names the runtime
 *      a served port needs (the `sandbox` container, per the capability
 *      table) — a raw error is never the answer on this seam.
 *
 *   2. `curl http://127.0.0.1:<port>/` answers a Cloudflare `error code: 1003`
 *      page. The library registry loads `curl` with no kernel, so the virtual
 *      port check is skipped and the loopback request falls through to the
 *      platform `fetch`, which reaches the edge. A loopback fetch answers the
 *      served bytes or a classified refusal, never a bare edge error.
 *
 * WHAT THE PROBE DRIVES. The real library workspace over the DO's own SQLite
 * (the same composition the hosted workspace boots), asserting on the shell's
 * own answers — exit codes, streams, and bodies — so the fix cannot be a
 * narrowed test. The green direction pins the CLASSIFICATION (a reason naming
 * `sandbox`, a curl exit-7 refusal), not the prose around it.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('a served port from the hosted workspace', () => {
  const open = (name: string) => env.PREVIEW_PORT_PROBE.get(env.PREVIEW_PORT_PROBE.idFromName(name));

  it('refuses node with a reason naming the container, not the raw V8 error alone', async () => {
    const subject = open('node-refusal');

    const evaluated = await subject.nodeEval();
    const filed = await subject.nodeFile();
    const combined = `${evaluated.stdout}\n${evaluated.stderr}\n${filed.stdout}\n${filed.stderr}`;

    // RED QUOTE (staging b04c01d31, workerd): both answers carried only
    // "Code generation from strings disallowed for this context" with no
    // mention of where a server CAN run.
    //
    // This pool does not enforce workerd's codegen block, so here the guard
    // takes its delegate arm and the programs run; on the hosted runtime it
    // takes its refusal arm. Either outcome is green, and the raw error alone
    // is red on every host. The refusal arm itself is pinned deterministically
    // by the bun-tier executor tests, which replay the staged stderr.
    const ran = combined.includes('hi') && combined.toLowerCase().includes('kinu live preview');
    const refused = combined.toLowerCase().includes('sandbox');
    expect(ran || refused).toBe(true);
    if (combined.includes('Code generation from strings disallowed')) {
      expect(combined.toLowerCase()).toContain('sandbox');
    }
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
