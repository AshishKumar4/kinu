// A slate's own fetch, as its room runs it (src/slates/room.ts): its shared server reaches the network only through the
// shared outbound policy, and a confined run, which may hold someone's data, reaches none at all.
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as v from 'valibot';

const Fetched = v.object({ status: v.optional(v.number()), location: v.optional(v.nullable(v.string())), body: v.optional(v.string()), error: v.optional(v.string()) });

const owner = 'egress-owner';

it("a slate's shared server fetches through the shared destination and manual-redirect policy", async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('egress-policy'));

  const answers = await subject.egressSlate({
    workspace: 'egress-policy', owner, calls: [
      // Must pass before any forbidden URL: proves the slate's final transport is the local fake.
      { method: 'shared', target: 'https://example.com/control' },
      { method: 'shared', target: 'https://example.com/redirect', redirect: 'manual' },
      // A redirect followed outside the binding re-enters the policy.
      { method: 'shared', target: 'https://example.com/redirect' },
      { method: 'shared', target: 'http://169.254.169.254/forbidden' },
      { method: 'shared', target: 'https://example.com/seen' },
    ],
  });

  const [control, manual, redirected, denied, seen] = answers.map((answer) => v.parse(Fetched, JSON.parse(answer)));

  expect(control).toMatchObject({ status: 200, body: 'public control' });
  expect.soft(manual).toMatchObject({ status: 302, location: 'http://169.254.169.254/forbidden' });
  expect.soft(redirected?.status).toBe(403);
  expect.soft(denied?.status).toBe(403);
  expect.soft(v.safeParse(v.pipe(v.string(), v.parseJson(), v.object({ reason: v.literal('denied') })), denied?.body).success).toBe(true);
  expect(JSON.parse(seen?.body ?? '{}')).toEqual({ forbiddenEgressHits: 0 });
});

// The resident path keyed loader images by their egress policy so an unmediated one could not serve a mediated start.
// A room's shared server and its confined runs are different isolates by construction; this is what that buys.
it("a confined run reaches no network, while the slate's shared server goes on reaching it through the policy", async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('egress-confined'));

  const [shared, confined, again] = (await subject.egressSlate({
    workspace: 'egress-confined', owner, calls: [
      { method: 'shared', target: 'https://example.com/control' },
      { method: 'confined', target: 'https://example.com/control' },
      { method: 'shared', target: 'https://example.com/control' },
    ],
  })).map((answer) => v.parse(Fetched, JSON.parse(answer)));

  expect(shared).toMatchObject({ status: 200, body: 'public control' });
  expect(confined?.status).toBeUndefined();
  expect(confined?.error).toBeDefined();
  expect(again).toMatchObject({ status: 200, body: 'public control' });
});

// The resident path kept Plan and Build processes apart so Plan could not reuse Build's egress. Plan does not run a
// slate's code at all now: the call is refused before the room is asked.
it("a Plan caller's call of a slate is refused before any of its code runs", async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('egress-plan'));

  await subject.egressSlate({ workspace: 'egress-plan', owner, calls: [{ method: 'shared', target: 'https://example.com/control' }] });

  expect(await subject.planCall({ workspace: 'egress-plan', owner })).toEqual({ ok: false, reason: 'denied' });
});
