// The attacks of lean/Kinu/Sharing/Attacks.lean, each against a built room (room-attacks.ts): real rooms, sockets,
// grants, sealed bindings and confined runs, the people's MCP servers faked at their own accounts, and every tool call
// that reaches an account logged. Each guard's removal turns its attack red here: the mutation runs are recorded in
// /mnt/local/kinu/tmp/sharing/mutations/ and cited in docs/SLATE-SHARING-SECURITY.md §8.
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const probe = () => env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('attacks'));

it('1, 2. Alice\'s repository reaches Bob only when Alice shows it: not by being stored, not by the owner\'s say', async () => {
  expect(await probe().attackHolder()).toEqual({
    alice: 'her secret', bobFirst: 'placeholder', afterSamShows: 'placeholder', afterAliceShows: 'shown',
  });
});

it('3. Alice\'s own GitHub, allowed for her part, never runs for Bob\'s request', async () => {
  expect(await probe().attackRequester()).toEqual({ alice: 'her secret', bob: 'part', aliceCallsForBob: 0 });
});

it('5. a function holding Sam\'s mail and Alice\'s repository never mails her data through his lend', async () => {
  expect(await probe().attackToolFlow()).toEqual({ samOwn: 'sent', alice: 'stopped', samMailsForAlice: 0 });
});

it('9. Alice\'s own mail, sending her own data where Sam\'s code picks, waits for her; declined, nothing is sent', async () => {
  expect(await probe().attackSink()).toEqual({ asked: 'outflow', mailedBeforeDeciding: 0, mailedAfter: 0, alice: 'stopped' });
});

it('10, 4. one approval lets one deploy through, only its holder approves, and a lend taken back ends the step that waited', async () => {
  expect(await probe().attackApprovals()).toEqual({
    bobApproves: 'refused', week2BeforeApproval: 0, week2AfterOne: 1, secondAsked: true, week3: 0, bob3: 'stopped',
  });
});

it('6. an editor\'s change never runs with Sam\'s grant: his lend and his own grant wait for him', async () => {
  expect(await probe().attackRevision()).toEqual({ edited: 'ok', bob: 'part', sam: 'stopped', deploysAfterEdit: 0 });
});

it('2, 8. a run that read Alice\'s repository posts nothing public: Bob\'s board holds no secret', async () => {
  expect(await probe().attackPost()).toEqual({ alice: 'stopped', bobBoard: 'value null' });
});

it('7. a fork holds none of its parent\'s lends: Sam\'s Ops is never called for Dana', async () => {
  expect(await probe().attackFork()).toEqual({ forked: 'ok', dana: 'stopped', samDeploysForDana: 0 });
});

it('the team board and the public dashboard: Sam decides twice, and no one who uses it is asked anything', async () => {
  expect(await probe().scenarioBoard()).toEqual({ alice: 'the board', bob: 'the board', visitor: 'the board', asked: { sam: 0, alice: 0, bob: 0 } });
});

it('the slate changes only for someone signed in, and a call that changed it is never run again by the room', async () => {
  const answered = await probe().roomWrites();

  expect(answered.visitorNote).toMatch(/^refused .*may not change the slate/);
  expect(answered.visitorPut).toMatch(/^refused .*changes only in a call|^refused .*Sign in/);
  expect([answered.bobNote, answered.notes]).toEqual(['value 1', 'value 1']);
  expect(answered.stamps).toBe('part');
  // It changed the slate once: the room asked Bob instead of running it again.
  expect(answered.stampedTwice).toBe('value 1');
});

it('6. a run runs the image it was admitted at: an editor\'s publish before its worker is made never runs under its grants', async () => {
  expect(await probe().attackStaleImage()).toEqual({ first: 'value "image-A"', edited: 'ok', held: 'value "image-A"', fromB: 0 });
});

it('a listing the Gallery lost comes back from the deploy\'s walk, which reaches its room', async () => {
  expect(await probe().listingRefill()).toEqual({ listed: true, lost: true, refilled: true });
});

it('a collaborator\'s own AI answers their call, in their own account: the owner\'s model is never asked', async () => {
  // Twice in Alice's account: the room runs her call once she allows her AI, and she asks again to read its answer.
  expect(await probe().ownAi()).toEqual({ alice: 'value "alice-own-ai@probe.local\'s own model"', aliceCalls: 2, samCalls: 0 });
});

it('a browser is driven only as its own person\'s, in their own request, through the room, and closed when that ends', { timeout: 60_000 }, async () => {
  const driven = await probe().browserDrives();

  // Sam drove his own once; lending `drive` lends no browser, so Bob is asked for his own instead.
  expect(driven.samLog).toEqual(['connected sam-browser-hangs-up', 'closed sam-browser-hangs-up']);
  expect(driven.lent).toBe('part');

  // Never authorized: the room refuses the dial. Bob's browser for Alice's request: never dialled.
  expect(driven.raw).toBe('value "refused"');
  expect(driven.others).toMatch(/^stopped:.*not one of/);
  expect(driven.othersLog).toEqual([]);
  // Hers: dialled once she let it, and closed when Sam removed her; her call ended with it.
  expect(driven.own).toEqual(['connected alice-browser', 'closed alice-browser']);
  // Her drive held its browser until then: the browser closed under it, and the call ended with it.
  expect(driven.afterRemoval).toMatch(/Target closed/);
  // Thirty forged dials of her browser while she drove it, each naming a run: every one refused, none connected.
  expect(driven.forged).toEqual([403]);
});
