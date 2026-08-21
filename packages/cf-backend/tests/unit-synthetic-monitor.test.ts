/**
 * Synthetic monitoring — the probes that would have caught the broken install
 * pipeline, and the incident ledger that keeps them from becoming noise.
 *
 * Two contracts:
 *   1. each probe fails on the real failure it exists for — chiefly the SPA
 *      fallback answering `200 index.html` for a missing download, which is
 *      what made a checksum mismatch look like a healthy site;
 *   2. one alert per distinct failure, not one per tick: a check that stays
 *      broken for hours produces exactly one email, and one more when it
 *      recovers.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { EmailOutbox, type OutboundEmailMessage } from '../src/email/outbox';
import { recordProbeRun, listIncidents, type MonitorDeps } from '../src/monitor/incidents';
import { runSyntheticProbes, type ProbeDeps, type ProbeOutcome } from '../src/monitor/probes';
import { sqlExec } from './helpers/user-do';

// ── A site to probe ──────────────────────────────────────────────

const SHA = 'c0ffee1234567890';
const TARBALL = new TextEncoder().encode('pretend this is the CLI source archive');
const SPA_SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';

async function tarballSha(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TARBALL);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A healthy origin, with `broken` naming the routes to sabotage. */
function site(broken: Partial<Record<string, () => Response>> = {}): ProbeDeps['fetch'] {
  const fetchSite: ProbeDeps['fetch'] = async (input) => {
    const path = new URL(new Request(input).url).pathname;
    const override = broken[path];
    if (override) return override();
    switch (path) {
      case '/api/health':
        return Response.json({ ok: true, sha: SHA, version: '0.1.0' });
      case '/downloads/kinu-version.json':
        return Response.json({ version: '0.1.0', sha: SHA, builtAt: '2026-08-07T00:00:00Z' });
      case '/downloads/kinu-source.tar.gz':
        return new Response(TARBALL);
      case '/downloads/kinu-source.tar.gz.sha256':
        return new Response(`${await tarballSha()}  kinu-source.tar.gz\n`);
      case '/login':
        return new Response(
          '<html><title>Sign in to Kinu</title><a class="provider" href="/auth/github/start">Continue</a></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      default:
        return new Response('not found', { status: 404 });
    }
  };
  return fetchSite;
}

/** The SPA fallback answering for a missing asset — the actual outage. */
const spaFallback = () => new Response(SPA_SHELL, { headers: { 'content-type': 'text/html' } });

async function probe(broken: Partial<Record<string, () => Response>> = {}): Promise<ProbeOutcome[]> {
  return runSyntheticProbes({ origin: 'https://kinu.test', fetch: site(broken) });
}

function outcome(outcomes: ProbeOutcome[], probeName: string): ProbeOutcome {
  const found = outcomes.find((o) => o.probe === probeName);
  if (!found) throw new Error(`no outcome for ${probeName}`);
  return found;
}

describe('synthetic probes', () => {
  test('a healthy site passes every probe', async () => {
    const outcomes = await probe();
    expect(outcomes.map((o) => o.probe)).toEqual(['health', 'downloads', 'login']);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });

  test('the SPA shell impersonating a checksum is caught', async () => {
    const outcomes = await probe({ '/downloads/kinu-source.tar.gz.sha256': spaFallback });
    expect(outcome(outcomes, 'downloads').ok).toBe(false);
    expect(outcome(outcomes, 'downloads').detail).toContain('not a sha256 line');
  });

  test('a tarball that does not match its checksum is caught', async () => {
    const outcomes = await probe({
      '/downloads/kinu-source.tar.gz': () => new Response(new TextEncoder().encode('a different build')),
    });
    expect(outcome(outcomes, 'downloads').ok).toBe(false);
    expect(outcome(outcomes, 'downloads').detail).toContain('install and update are both refusing');
  });

  test('health answering HTML instead of JSON is caught', async () => {
    const outcomes = await probe({ '/api/health': spaFallback });
    expect(outcome(outcomes, 'health').ok).toBe(false);
    expect(outcome(outcomes, 'health').detail).toContain('SPA fallback');
  });

  test('a worker and assets from different deploys are caught', async () => {
    const outcomes = await probe({
      '/api/health': () => Response.json({ ok: true, sha: 'deadbeef' }),
    });
    expect(outcome(outcomes, 'health').ok).toBe(false);
    expect(outcome(outcomes, 'health').detail).toContain('different deploys');
  });

  test('a health endpoint with no build identifier is caught', async () => {
    const outcomes = await probe({ '/api/health': () => Response.json({ ok: true }) });
    expect(outcome(outcomes, 'health').ok).toBe(false);
    expect(outcome(outcomes, 'health').detail).toContain('no build identifier');
  });

  test('a sign-in page with no provider is caught', async () => {
    const outcomes = await probe({
      '/login': () => new Response('<html><title>Sign in to Kinu</title><p>No OAuth providers</p></html>'),
    });
    expect(outcome(outcomes, 'login').ok).toBe(false);
    expect(outcome(outcomes, 'login').detail).toContain('nobody can sign in');
  });

  test('an origin that does not answer is a failure, not an exception', async () => {
    const unavailableFetch: ProbeDeps['fetch'] = async () => {
      throw new Error('connection refused');
    };
    const outcomes = await runSyntheticProbes({
      origin: 'https://kinu.test',
      fetch: unavailableFetch,
    });
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(outcome(outcomes, 'health').detail).toContain('connection refused');
  });
});

// ── The incident ledger ──────────────────────────────────────────

function ledger(alertEmail: string | null = 'owner@example.com') {
  const db = new Database(':memory:');
  const sql = sqlExec(db);
  const sent: OutboundEmailMessage[] = [];
  let failSends = false;
  const OutboundMessageSchema = v.object({
    from: v.union([v.string(), v.object({ email: v.string(), name: v.string() })]),
    to: v.union([
      v.string(),
      v.object({ email: v.string(), name: v.string() }),
      v.array(v.union([v.string(), v.object({ email: v.string(), name: v.string() })])),
    ]),
    subject: v.string(),
    text: v.string(),
    headers: v.optional(v.record(v.string(), v.string())),
  });
  type SendEmailBuilder = Parameters<SendEmail['send']>[0];
  function send(message: EmailMessage): Promise<EmailSendResult>;
  function send(message: SendEmailBuilder): Promise<EmailSendResult>;
  async function send(message: EmailMessage | SendEmailBuilder): Promise<EmailSendResult> {
    if (failSends) throw new Error('mail transport down');
    sent.push(v.parse(OutboundMessageSchema, message));
    return { messageId: `monitor-${sent.length}` };
  }
  const binding: SendEmail = { send };
  const outbox = new EmailOutbox(sql);
  const deps = (now: number): MonitorDeps => ({
    sql, outbox, email: binding, emailDomain: 'kinu.test', alertEmail,
    origin: 'https://kinu.test', now,
  });
  return { sql, sent, deps, breakMail: (on: boolean) => { failSends = on; } };
}

const FAILING: ProbeOutcome[] = [{ probe: 'downloads', ok: false, detail: 'checksum mismatch' }];
const PASSING: ProbeOutcome[] = [{ probe: 'downloads', ok: true, detail: 'sha256 ok' }];

describe('alert fatigue', () => {
  test('a check that stays broken emails once, then once more on recovery', async () => {
    const l = ledger();

    const first = await recordProbeRun(l.deps(1_000), FAILING);
    expect(first.alerting).toEqual(['downloads']);
    expect(first.emails).toBe(1);
    expect(l.sent).toHaveLength(1);
    expect(l.sent[0]!.subject).toContain('downloads is failing');
    expect(l.sent[0]!.text).toContain('checksum mismatch');
    // The alert says what a user hits, and what to do about it.
    expect(l.sent[0]!.text).toContain('kinu update');
    expect(l.sent[0]!.text).toContain('scripts/deploy.sh');

    // Nine more ticks over the next two hours: still broken, still one email.
    for (let tick = 1; tick <= 9; tick++) {
      const again = await recordProbeRun(l.deps(1_000 + tick * 900_000), FAILING);
      expect(again.emails).toBe(0);
      expect(again.alerting).toEqual([]);
    }
    expect(l.sent).toHaveLength(1);
    expect(listIncidents(l.sql)[0]).toMatchObject({ probe: 'downloads', failures: 10 });

    const recovered = await recordProbeRun(l.deps(1_000 + 10 * 900_000), PASSING);
    expect(recovered.recovered).toEqual(['downloads']);
    expect(recovered.emails).toBe(1);
    expect(l.sent).toHaveLength(2);
    expect(l.sent[1]!.subject).toContain('downloads recovered');
    expect(l.sent[1]!.text).toContain('3 hours');
    expect(listIncidents(l.sql)).toEqual([]);

    // A passing check with no open incident is silent.
    expect((await recordProbeRun(l.deps(2_000_000), PASSING)).emails).toBe(0);
    expect(l.sent).toHaveLength(2);
  });

  test('two checks breaking at once are one email, and a later one is its own', async () => {
    const l = ledger();
    await recordProbeRun(l.deps(1_000), [
      { probe: 'downloads', ok: false, detail: 'checksum mismatch' },
      { probe: 'login', ok: false, detail: 'no provider' },
    ]);
    expect(l.sent).toHaveLength(1);
    expect(l.sent[0]!.subject).toContain('2 checks are failing');

    const later = await recordProbeRun(l.deps(900_000), [
      { probe: 'downloads', ok: false, detail: 'checksum mismatch' },
      { probe: 'login', ok: false, detail: 'no provider' },
      { probe: 'health', ok: false, detail: 'HTTP 500' },
    ]);
    expect(later.alerting).toEqual(['health']);
    expect(l.sent).toHaveLength(2);
    expect(l.sent[1]!.subject).toContain('health is failing');
  });

  test('a failing check whose detail changes does not re-alert', async () => {
    const l = ledger();
    await recordProbeRun(l.deps(1_000), [{ probe: 'health', ok: false, detail: 'HTTP 500' }]);
    await recordProbeRun(l.deps(900_000), [{ probe: 'health', ok: false, detail: 'HTTP 502' }]);
    expect(l.sent).toHaveLength(1);
    expect(listIncidents(l.sql)[0]!.detail).toBe('HTTP 502');
  });

  test('an alert whose send fails is retried, and still lands only once', async () => {
    const l = ledger();
    l.breakMail(true);
    const failed = await recordProbeRun(l.deps(1_000), FAILING);
    expect(failed.emails).toBe(0);
    expect(l.sent).toHaveLength(0);

    l.breakMail(false);
    const retried = await recordProbeRun(l.deps(900_000), FAILING);
    expect(retried.emails).toBe(1);
    expect(l.sent).toHaveLength(1);

    const after = await recordProbeRun(l.deps(1_800_000), FAILING);
    expect(after.emails).toBe(0);
    expect(l.sent).toHaveLength(1);
  });

  test('without an alert address the monitor records but stays silent', async () => {
    const l = ledger(null);
    const result = await recordProbeRun(l.deps(1_000), FAILING);
    expect(result.emails).toBe(0);
    expect(result.skipped).toBe('email not configured');
    expect(listIncidents(l.sql)).toHaveLength(1);
    expect(l.sent).toHaveLength(0);
  });
});
