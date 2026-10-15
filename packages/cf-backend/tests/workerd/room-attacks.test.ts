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


