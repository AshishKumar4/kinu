import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as v from 'valibot';

const Answer = v.object({ calls: v.number(), status: v.optional(v.number()),
  body: v.optional(v.string()), location: v.optional(v.nullable(v.string())), error: v.optional(v.string()) });

it('resident global fetch uses the shared destination and manual-redirect policy', async () => {
  const subject = env.SLATE_EGRESS_PROBE.get(env.SLATE_EGRESS_PROBE.idFromName('egress-policy'));
  const request = async (target: string, redirect: RequestRedirect = 'follow') => v.parse(Answer, JSON.parse(await subject.request('build', target, redirect)));
  // This must pass before any forbidden URL is requested: it establishes the
  // actual resident's final transport is the local mock, not the real network.
  expect(await request('https://example.com/control')).toMatchObject({ status: 200, body: 'public control' });
  const manual = await request('https://example.com/redirect', 'manual');
  expect.soft(manual).toMatchObject({ status: 302, location: 'http://169.254.169.254/forbidden' });
  // Native global fetch may follow the response outside the binding; that next
  // hop must re-enter the policy instead of reaching the denied transport.
  const redirected = await request('https://example.com/redirect');
  expect.soft(redirected.status).toBe(403);
  const denied = await request('http://169.254.169.254/forbidden');
  expect.soft(denied.status).toBe(403);
  const refusal = v.safeParse(v.pipe(v.string(), v.parseJson(), v.object({ reason: v.literal('denied') })), denied.body);
  expect.soft(refusal.success).toBe(true);
  const seen = await request('https://example.com/seen');
  expect(JSON.parse(seen.body ?? '{}')).toEqual({ forbiddenEgressHits: 0 });
});

it('a Plan caller cannot reuse Build egress, including a captured fetch reference, and independent Build stays live', async () => {
  const subject = env.SLATE_EGRESS_PROBE.get(env.SLATE_EGRESS_PROBE.idFromName('egress-modes'));
  const build = v.parse(Answer, JSON.parse(await subject.request('build', 'https://example.com/control')));
  expect(build).toMatchObject({ calls: 1, status: 200, body: 'public control' });
  const plan = v.parse(Answer, JSON.parse(await subject.request('plan', 'https://example.com/control')));
  expect(plan.error).toContain('not permitted to access the internet');
  expect(await subject.publicPlanCall()).toMatchObject({ ok: false, reason: 'denied' });
  const resumed = v.parse(Answer, JSON.parse(await subject.request('build', 'https://example.com/control')));
  expect(resumed).toMatchObject({ calls: 2, status: 200, body: 'public control' });
});

it('a cached unmediated loader image cannot satisfy a mediated start for the same source and caller', async () => {
  const subject = env.SLATE_EGRESS_PROBE.get(env.SLATE_EGRESS_PROBE.idFromName('egress-upgrade'));
  const result = await subject.unmediatedThenMediated();
  expect(JSON.parse(result.unmediated)).toMatchObject({ unmediated: true, status: 200, body: 'public control' });
  const mediated = v.parse(Answer, JSON.parse(result.mediated));
  expect(mediated).toMatchObject({ calls: 1, status: 403 });
  expect(JSON.parse(mediated.body ?? '{}')).toMatchObject({ reason: 'denied' });
  expect(JSON.parse(result.reused)).toMatchObject({ calls: 2, status: 200, body: 'public control' });
});
