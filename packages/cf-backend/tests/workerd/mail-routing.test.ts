/**
 * @vitest-environment node
 */
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { beforeEach, describe, expect, it } from 'vitest';

// Mail on a subdomain of its zone (docs/MAIL.md §5). Priya Raman's deployment receives at mail.northwind.dev, under
// Northwind's zone, whose catch-all is the zone's own and never this deployment's. Each address she and her agents are
// given routes by a rule of its own, made as the address is; deleting her account deletes those rules; and nothing
// disables the zone's routing.

const DOMAIN = 'mail.northwind.dev';

const name = (label: string) => env.ROUTED_MAILNAME.get(env.ROUTED_MAILNAME.idFromName(label));

const mailbox = (userId: string) => env.ROUTED_MAILBOX.get(env.ROUTED_MAILBOX.idFromName(userId));

/** A call from the Northwind API workspace: its main agent, or its triage agent. */
const caller = (actorId: 'main' | 'triage') => ({
  workspace: 'northwind-api', title: 'Northwind API', mainActorId: 'main', actorId, name: actorId === 'main' ? 'Northwind API' : 'Triage',
});

/** Her address, under a label each test keeps to itself: a label is claimed once, for good. Opening the box claims it. */
async function priyaOpened(label: string, userId: string) {
  await mailbox(userId).open({ userId, email: 'priya.raman@example.com', username: label, assistant: null });
}

const Refusal = v.object({ code: v.string(), message: v.string() });

/** A call's refusal as a value, read once: an RPC promise handed to `expect` is read again by its matchers. */
async function refusalOf(call: () => Promise<object>): Promise<v.InferOutput<typeof Refusal> | null> {
  const [settled] = await Promise.allSettled([call()]);

  return settled?.status === 'rejected' ? v.parse(Refusal, settled.reason) : null;
}

beforeEach(async () => {
  await env.MAIL_RULES_FAKE.reset();
});

describe('mail on a subdomain of its zone, each address by a rule of its own', () => {
  it("routes the person's address as her box is opened, and her workspace's and agent's before their first call reads them", async () => {
    await priyaOpened('priya', 'u-priya-1');

    expect((await env.MAIL_RULES_FAKE.state()).addresses).toEqual([`priya@${DOMAIN}`]);

    const boxes = await mailbox('u-priya-1').readableBy(caller('triage'));

    expect(boxes.map((box) => box.address)).toEqual([`triage.northwind-api.priya@${DOMAIN}`, `northwind-api.priya@${DOMAIN}`]);
    expect([...(await env.MAIL_RULES_FAKE.state()).addresses].sort()).toEqual([`northwind-api.priya@${DOMAIN}`, `priya@${DOMAIN}`, `triage.northwind-api.priya@${DOMAIN}`]);

    // Made once: a second call routes nothing again.
    await mailbox('u-priya-1').readableBy(caller('triage'));
    expect((await env.MAIL_RULES_FAKE.state()).calls.filter((call) => call.startsWith('POST'))).toHaveLength(3);
  });

  it("refuses the 201st address in Cloudflare's words, and makes nothing of it", async () => {
    await priyaOpened('priyaraman', 'u-priya-2');
    await mailbox('u-priya-2').readableBy(caller('main'));
    await env.MAIL_RULES_FAKE.cap(2);

    expect(await refusalOf(async () => mailbox('u-priya-2').readableBy(caller('triage')))).toMatchObject({
      code: 'denied', message: `routing triage.northwind-api.priyaraman@${DOMAIN}: Cloudflare answered: Rule limit reached`,
    });
    expect((await mailbox('u-priya-2').boxes()).map((box) => box.path).sort()).toEqual(['', 'northwind-api']);

    expect(await refusalOf(async () => mailbox('u-dana').open({ userId: 'u-dana', email: 'dana@northwind.io', username: 'dana', assistant: null }))).toMatchObject({
      code: 'denied', message: `routing dana@${DOMAIN}: Cloudflare answered: Rule limit reached`,
    });
    // Neither the name nor the box: the rows the box wrote first are unwritten with the claim refused.
    expect(await name('dana').lookup()).toBeNull();
    expect(await mailbox('u-dana').boxes()).toEqual([]);
  });

  // Review, 2026-10-21: a box was made before its rule, so a refusal on the second box of a call left the first's rule
  // spent on a box unmade, and a box whose rule was never made could be read.
  it('makes each box only once its rule is, and keeps those whose rules were made when a later one is refused', async () => {
    await priyaOpened('priyar', 'u-priya-4');
    await env.MAIL_RULES_FAKE.cap(2);

    expect(await refusalOf(async () => mailbox('u-priya-4').readableBy(caller('triage')))).toMatchObject({
      code: 'denied', message: `routing triage.northwind-api.priyar@${DOMAIN}: Cloudflare answered: Rule limit reached`,
    });
    expect((await mailbox('u-priya-4').boxes()).map((box) => box.address).sort()).toEqual([`northwind-api.priyar@${DOMAIN}`, `priyar@${DOMAIN}`]);
    expect([...(await env.MAIL_RULES_FAKE.state()).addresses].sort()).toEqual([`northwind-api.priyar@${DOMAIN}`, `priyar@${DOMAIN}`]);
  });

  // Review, 2026-10-21: a deployment that moved its mail onto a subdomain left the addresses it had already made unrouted.
  it('routes every address it already has again when they were last routed under another grant', async () => {
    await priyaOpened('pr', 'u-priya-5');
    await mailbox('u-priya-5').readableBy(caller('triage'));
    await env.MAIL_RULES_FAKE.reset();
    await mailbox('u-priya-5').routedUnder('zone-west mail.west.dev');

    await mailbox('u-priya-5').boxes();

    expect([...(await env.MAIL_RULES_FAKE.state()).addresses].sort()).toEqual([`northwind-api.pr@${DOMAIN}`, `pr@${DOMAIN}`, `triage.northwind-api.pr@${DOMAIN}`]);
  });

  // The lead's decision, 2026-10-21: the box records the name first, then claims it, so an account holds no name its
  // deletion cannot find, and none it does not own.
  it('a name another account holds leaves the box unopened, recording nothing', async () => {
    await priyaOpened('owned', 'u-priya-6');

    expect(await refusalOf(async () => mailbox('u-dana-6').open({ userId: 'u-dana-6', email: 'dana@northwind.io', username: 'owned', assistant: null }))).toMatchObject({
      code: 'denied', message: expect.stringContaining('"owned" is taken.'),
    });
    expect(await mailbox('u-dana-6').boxes()).toEqual([]);
    expect(await name('owned').lookup()).toMatchObject({ user_id: 'u-priya-6' });
  });

  // The lead's decision, 2026-10-21: `mail:claimed` acknowledges the box's own two-object step; every call finishes an
  // unacknowledged claim, and rows go only on MailName's own refusal.
  it('an open whose claim reply was lost after the claim is finished by the next call', async () => {
    expect(await refusalOf(async () => mailbox('u-lost-1').open({ userId: 'u-lost-1', email: 'priya.raman@example.com', username: 'lostafter1', assistant: null })))
      .toMatchObject({ code: 'io', message: 'claiming lostafter1' });

    expect((await mailbox('u-lost-1').boxes()).map((box) => box.address)).toEqual([`lostafter1@${DOMAIN}`]);
    expect(await name('lostafter1').lookup()).toMatchObject({ user_id: 'u-lost-1' });
    expect((await env.MAIL_RULES_FAKE.state()).addresses).toEqual([`lostafter1@${DOMAIN}`]);
  });

  it('an open cut off before its claim, whose name another account then takes, is undone by its next call', async () => {
    expect(await refusalOf(async () => mailbox('u-lost-2').open({ userId: 'u-lost-2', email: 'priya.raman@example.com', username: 'lostbefore1', assistant: null })))
      .toMatchObject({ code: 'io', message: 'claiming lostbefore1' });
    await priyaOpened('lostbefore1', 'u-dana-2');

    expect(await refusalOf(async () => mailbox('u-lost-2').boxes())).toMatchObject({ code: 'denied', message: '"lostbefore1" is taken.' });
    expect(await mailbox('u-lost-2').boxes()).toEqual([]);
    expect(await name('lostbefore1').lookup()).toMatchObject({ user_id: 'u-dana-2' });
  });

  it("deleting an account whose open was cut off before its claim takes nothing of the account that holds the name", async () => {
    expect(await refusalOf(async () => mailbox('u-lost-3').open({ userId: 'u-lost-3', email: 'priya.raman@example.com', username: 'lostbefore2', assistant: null })))
      .toMatchObject({ code: 'io', message: 'claiming lostbefore2' });
    await priyaOpened('lostbefore2', 'u-dana-3');

    await mailbox('u-lost-3').deleteBox('u-lost-3');

    expect((await env.MAIL_RULES_FAKE.state()).addresses).toEqual([`lostbefore2@${DOMAIN}`]);
    expect(await name('lostbefore2').lookup()).toMatchObject({ user_id: 'u-dana-3' });
  });

  // Last review, 2026-10-21: any refusal MailName wrote unwrote the rows, a store it could not read among them, and a
  // claim cut off after its rule was made left that rule to no one.
  it('a refusal that is no denial keeps the rows, and the next call claims again', async () => {
    expect(await refusalOf(async () => mailbox('u-store-1').open({ userId: 'u-store-1', email: 'priya.raman@example.com', username: 'refusedstore1', assistant: null })))
      .toMatchObject({ code: 'unavailable' });

    expect((await mailbox('u-store-1').boxes()).map((box) => box.address)).toEqual([`refusedstore1@${DOMAIN}`]);
    expect(await name('refusedstore1').lookup()).toMatchObject({ user_id: 'u-store-1' });
  });

  it("deleting an account whose claim was cut off after its rule was made deletes that rule, which no one's claim holds", async () => {
    expect(await refusalOf(async () => mailbox('u-routed-1').open({ userId: 'u-routed-1', email: 'priya.raman@example.com', username: 'lostrouted1', assistant: null })))
      .toMatchObject({ code: 'io', message: 'claiming lostrouted1' });
    expect((await env.MAIL_RULES_FAKE.state()).addresses).toEqual([`lostrouted1@${DOMAIN}`]);

    await mailbox('u-routed-1').deleteBox('u-routed-1');

    expect((await env.MAIL_RULES_FAKE.state()).addresses).toEqual([]);
    expect(await name('lostrouted1').lookup()).toBeNull();
  });

  it("deletes every rule under the account's root as the account is, and never disables the zone's routing", async () => {
    await priyaOpened('praman', 'u-priya-3');
    await mailbox('u-priya-3').readableBy(caller('triage'));
    await priyaOpened('danaw', 'u-dana-w');

    await mailbox('u-priya-3').deleteBox('u-priya-3');
    const after = await env.MAIL_RULES_FAKE.state();

    expect(after.addresses).toEqual([`danaw@${DOMAIN}`]);
    expect(await name('praman').lookup()).toMatchObject({ label: 'praman', user_id: '' });
    expect(after.calls.filter((call) => call.includes('/email/routing/dns'))).toEqual([]);
    expect(after.calls.filter((call) => call.startsWith('DELETE')).every((call) => /\/email\/routing\/rules\/rule-\d+$/u.test(call))).toBe(true);
  });
});
