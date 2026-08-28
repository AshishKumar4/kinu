/**
 * Duplicate sends, refused by the Durable Object rather than by the browser.
 *
 * The client-side latch is proven twice already (`unit-send-admission.test.ts`
 * as a unit, `scripts/chat-and-files-ux.test.ts` at the real composer) and both
 * proofs end at the client. These tests start where those stop: the send has
 * already left, twice, and the only thing that can still refuse the second one
 * is the object the sends land on.
 *
 * Three shapes, all of them ways a client that never double-pressed still sends
 * twice:
 *   - two clients on one conversation, arriving as separate HTTP requests;
 *   - one client whose sends overlap inside a single tick;
 *   - a socket that dropped after the send left and replayed it on reconnect.
 *
 * And the release: a turn the provider FAILED must not wedge the object. The
 * duplicate refusal and the release are the same mechanism seen from two sides —
 * a ledger that never settles refuses everything after it.
 *
 * The oracles are the object's own public reads: the receipt each caller got,
 * the submission ledger, the durable count of provider requests actually issued,
 * and the stored transcript. Nothing here reads our source.
 */
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** Generous, never spent by a passing run: every wait below stops at its
 *  condition. It bounds only how long a broken platform gets before the
 *  assertion reports the state actually reached. */
const SETTLE_DEADLINE_MS = 30_000;
const POLL_MS = 25;

const TERMINAL = ['completed', 'aborted', 'skipped', 'error'];

const ReceiptSchema = v.object({
  submissionId: v.string(),
  accepted: v.boolean(),
  status: v.string(),
});
type Receipt = v.InferOutput<typeof ReceiptSchema>;

const probe = (name: string) =>
  env.SEND_ADMISSION_PROBE.get(env.SEND_ADMISSION_PROBE.idFromName(name));

/** One send through the worker route — a real HTTP request, resolved to the
 *  object by the conversation name in the path. */
async function sendOverRoute(name: string, key: string, text: string): Promise<Receipt> {
  const response = await SELF.fetch(`https://send.test/send/${name}/${key}`, {
    method: 'POST',
    body: text,
  });
  expect(response.status).toBe(200);
  return v.parse(ReceiptSchema, await response.json());
}

/** Wait until every submission the object holds has settled. Condition-bound,
 *  so a passing run pays only the time the turns actually take. */
async function untilSettled(name: string, expected: number): Promise<
  { idempotencyKey: string | undefined; submissionId: string; status: string }[]
> {
  const started = Date.now();
  for (;;) {
    const rows = await probe(name).submissions();
    const settled = rows.filter((row) => TERMINAL.includes(row.status));
    if (rows.length >= expected && settled.length === rows.length) return rows;
    if (Date.now() - started > SETTLE_DEADLINE_MS) return rows;
    await scheduler.wait(POLL_MS);
  }
}

describe('two clients sending the same message at once', () => {
  it('admits one turn, issues one provider request, and hands both callers the same receipt', async () => {
    const name = 'two-clients';

    // Two independent worker invocations, in flight together, on one object.
    const [first, second] = await Promise.all([
      sendOverRoute(name, 'send-1', 'do the work'),
      sendOverRoute(name, 'send-1', 'do the work'),
    ]);

    // One send, so one identity: the loser is told which submission its send
    // became, not handed a second one.
    expect(second.submissionId).toBe(first.submissionId);
    expect([first.accepted, second.accepted].filter(Boolean)).toHaveLength(1);

    const rows = await untilSettled(name, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');

    // The two oracles the receipt cannot give: the work was done ONCE, and the
    // conversation carries one answer rather than two.
    expect(await probe(name).providerCalls()).toBe(1);
    expect(await probe(name).answers()).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: two DIFFERENT sends at once are both admitted', async () => {
    const name = 'two-clients-distinct';

    const [first, second] = await Promise.all([
      sendOverRoute(name, 'send-a', 'first thing'),
      sendOverRoute(name, 'send-b', 'second thing'),
    ]);

    // Nothing about arriving together makes a send lose. The refusal above is
    // the key's doing, not the object serializing everything into one turn.
    expect(second.submissionId).not.toBe(first.submissionId);
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);

    const rows = await untilSettled(name, 2);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'completed')).toBe(true);
    expect(await probe(name).providerCalls()).toBe(2);
    expect(await probe(name).answers()).toHaveLength(2);
  });
});

describe('two sends that overlap inside one tick', () => {
  it('still resolve to one submission and one turn', async () => {
    const name = 'same-tick';

    // No await between them: every one is inside the admission decision before
    // any has committed. The control below establishes that this interleaving is
    // real on this runtime rather than collapsed into a sequence.
    const receipts = await probe(name).submitTogether('do the work', ['send-1', 'send-1', 'send-1']);

    expect(new Set(receipts.map((receipt) => receipt.submissionId)).size).toBe(1);
    expect(receipts.filter((receipt) => receipt.accepted)).toHaveLength(1);

    const rows = await untilSettled(name, 1);
    expect(rows).toHaveLength(1);
    expect(await probe(name).providerCalls()).toBe(1);
    expect(await probe(name).answers()).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: a guard that reads durable state across an await admits every caller', async () => {
    // Three callers, one claim, and all three win it. The window the durable
    // ledger closes is open here — so the assertions above are reading a
    // refusal, not a runtime that never let the race happen.
    expect(await probe('reactive-control').raceReactiveGuard(3)).toBe(3);
  });
});

describe('a send replayed after the socket dropped', () => {
  it('is recognised as the same send, and does not run a second turn', async () => {
    const name = 'reconnect-replay';

    const first = await sendOverRoute(name, 'send-1', 'do the work');
    expect(first.accepted).toBe(true);
    const settled = await untilSettled(name, 1);
    expect(settled[0]?.status).toBe('completed');

    // The client never learned the send landed, so on reconnect it sends the
    // same thing again. A new HTTP request, a new worker invocation, the same
    // key.
    const replay = await sendOverRoute(name, 'send-1', 'do the work');
    expect(replay.submissionId).toBe(first.submissionId);
    expect(replay.accepted).toBe(false);
    expect(replay.status).toBe('completed');

    expect(await probe(name).submissions()).toHaveLength(1);
    expect(await probe(name).providerCalls()).toBe(1);
    expect(await probe(name).answers()).toHaveLength(1);
  });
});

describe('a turn the provider failed', () => {
  it('settles as an error and leaves the object able to admit the next send', async () => {
    const name = 'provider-failure';
    await probe(name).armProviderFailures(1);

    const failing = await sendOverRoute(name, 'send-1', 'do the work');
    expect(failing.accepted).toBe(true);

    const afterFailure = await untilSettled(name, 1);
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]?.status).toBe('error');
    expect(await probe(name).providerCalls()).toBe(1);
    expect(await probe(name).answers()).toHaveLength(0);

    // THE RELEASE. A failed turn is a settled turn: the next send is a new send
    // and has to be admitted, or one provider outage ends the conversation.
    const retry = await sendOverRoute(name, 'send-2', 'try that again');
    expect(retry.accepted).toBe(true);

    const afterRetry = await untilSettled(name, 2);
    expect(afterRetry).toHaveLength(2);
    expect(afterRetry.find((row) => row.idempotencyKey === 'send-2')?.status).toBe('completed');
    expect(await probe(name).providerCalls()).toBe(2);
    expect(await probe(name).answers()).toHaveLength(1);
  });

  it('does not re-run the failed send when the client replays it', async () => {
    const name = 'failure-replay';
    await probe(name).armProviderFailures(1);

    const failing = await sendOverRoute(name, 'send-1', 'do the work');
    expect((await untilSettled(name, 1))[0]?.status).toBe('error');

    // A settled key stays settled, whichever way it settled. The replay reports
    // the recorded outcome instead of retrying work whose side effects the
    // object cannot know about.
    const replay = await sendOverRoute(name, 'send-1', 'do the work');
    expect(replay.submissionId).toBe(failing.submissionId);
    expect(replay.accepted).toBe(false);
    expect(replay.status).toBe('error');
    expect(await probe(name).providerCalls()).toBe(1);
  });
});
