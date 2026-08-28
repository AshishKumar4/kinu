/**
 * The tool-effect claim, across an isolate the object never chose to end.
 *
 * WHAT THIS IS THE PRIMITIVE OF. Every once-only guarantee in the harness rests
 * on `claimToolEffect`/`settleToolEffect`: a tool that can send mail, spend
 * money, or write to somebody else's system is admitted exactly once per turn
 * because a row is claimed before the effect and settled after it. The terminal
 * transition gate is one caller of it; `withEffectClaims` is the other, and that
 * one reads all three answers.
 *
 * WHAT WE HAD BEFORE THIS FILE. `packages/core/tests/unit-tool-effect-claim.test.ts`
 * states every one of these claims over `bun:sqlite`. That is the right place
 * for the DECISIONS — they are our code — but it leaves the load-bearing claim a
 * statement about a fake database and a harness that never stopped running. The
 * three answers are only distinguishable BECAUSE an activation can die between
 * the claim and the settle, and nothing outside workerd can kill one.
 *
 * WHY `bun test` CANNOT HOST IT. `abortAllDurableObjects()` exists only in
 * workerd. `indeterminate` is the answer a dead activation leaves behind, so
 * under bun it can be reached only by writing the row that stands for one.
 *
 * WHICH LAYER THIS REACHES. Core's two functions over real Durable Object
 * SQLite, over the schema `initToolEffectClaimTable` creates — no ledger, no
 * actor, no tool. A tool call's claim has nothing scheduled behind it: refusing
 * IS its recovery, which is why every assertion here is a read of the claim and
 * never a count of side effects.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProbeToolCall } from './terminal-effect-probe';

/** A stub held across a reset is itself broken by the reset; the id survives.
 *  Re-acquiring is what a real caller does on its next request. */
const probe = (name: string) =>
  env.TERMINAL_EFFECT_PROBE.get(env.TERMINAL_EFFECT_PROBE.idFromName(name));

/** The call under test. Irreversible by construction, because that is the only
 *  kind of call this table exists for. */
const SEND: ProbeToolCall = {
  turnId: 'u-claim',
  callId: 'call_send_1',
  tool: 'send_email',
  args: { to: 'ada@example.com', subject: 'once' },
};

/** Same turn, same call id, DIFFERENT arguments. A separate identity, because
 *  the digest is part of the key: a provider that reissued a call id over new
 *  arguments must not be handed the old call's outcome. */
const SEND_OTHER_ARGS: ProbeToolCall = {
  ...SEND,
  args: { to: 'grace@example.com', subject: 'once' },
};

/** A different call in the same turn. Nothing below may reach it. */
const OTHER_CALL: ProbeToolCall = { ...SEND, callId: 'call_send_2' };

/** The same call in a different turn. Claims are per turn, so a later turn
 *  asking for the same effect is asking a new question. */
const NEXT_TURN: ProbeToolCall = { ...SEND, turnId: 'u-claim-next' };

/** Two answers for one effect. The second stands for a replay that got further
 *  than the attempt before it and tried to record its own outcome. */
const FIRST_RESULT = '{"delivered":true,"id":"msg-1"}';
const SECOND_RESULT = '{"delivered":true,"id":"msg-2-a-replay-must-never-record"}';

const CLAIMED = { kind: 'claimed', result: null };
const REFUSED = { kind: 'indeterminate', result: null };

describe('a tool effect claimed on an isolate that dies before settling', () => {
  /**
   * The refusal, at the tier where the isolate genuinely dies.
   *
   * A claimed-and-unsettled row is the one state nobody can interpret: the
   * effect may have happened and may not, and the row cannot say which. Running
   * the call again could send a second mail, so the harness declines. Everything
   * after `abortAllDurableObjects()` is a fresh activation with nothing
   * hydrated — no promise, no in-memory set, only the table.
   */
  it('reports indeterminate to the next activation, not claimed', async () => {
    const stub = probe('tool-claim-refusal');

    // The claim, and nothing after it. This is an activation that got as far as
    // reserving the effect and then stopped existing.
    expect(await stub.claimTool(SEND)).toEqual(CLAIMED);

    // The eviction nobody schedules: a deploy, a runtime restart, an
    // alarm-boundary reset.
    await abortAllDurableObjects();

    const fresh = probe('tool-claim-refusal');
    expect(await fresh.claimTool(SEND)).toEqual(REFUSED);
    // And it stays refused. A read that reports `indeterminate` must not leave
    // the row claimable by the attempt after it.
    expect(await fresh.claimTool(SEND)).toEqual(REFUSED);

    // Nothing else in the table is touched by any of that, which is what makes
    // the refusal a decision about ONE call rather than about the turn.
    expect(await fresh.claimTool(SEND_OTHER_ARGS)).toEqual(CLAIMED);
    expect(await fresh.claimTool(OTHER_CALL)).toEqual(CLAIMED);
    expect(await fresh.claimTool(NEXT_TURN)).toEqual(CLAIMED);
  });
});

describe('a tool effect settled after the eviction that interrupted it', () => {
  /**
   * First writer wins, and the winner survives a second isolate death.
   *
   * The settle is an UPDATE guarded on the result still being absent, so the
   * question is what a REPLAY does when it reaches the settle holding a
   * different answer. It has to lose: a caller that already read the first
   * result would otherwise be holding an outcome the row no longer agrees with.
   *
   * The second eviction is here because a read taken in the activation that
   * wrote the row proves only that SQLite honoured the guard. Killing the
   * isolate first makes it a statement about what the DISK holds.
   */
  it('keeps the first result, and a duplicate settle cannot overwrite it', async () => {
    const stub = probe('tool-claim-first-writer');

    expect(await stub.claimTool(SEND)).toEqual(CLAIMED);

    await abortAllDurableObjects();

    const recovered = probe('tool-claim-first-writer');
    expect(await recovered.claimTool(SEND)).toEqual(REFUSED);

    // The effect finishes and is recorded, then recorded again with a different
    // answer.
    await recovered.settleTool(SEND, FIRST_RESULT);
    await recovered.settleTool(SEND, SECOND_RESULT);
    expect(await recovered.claimTool(SEND)).toEqual({ kind: 'settled', result: FIRST_RESULT });

    await abortAllDurableObjects();

    const fresh = probe('tool-claim-first-writer');
    // The read a replayed tool call actually makes: it returns this INSTEAD of
    // running the call, so the result carried here is the once-only guarantee.
    expect(await fresh.claimTool(SEND)).toEqual({ kind: 'settled', result: FIRST_RESULT });
    // Settled is settled for good — a later attempt cannot reopen it either.
    await fresh.settleTool(SEND, SECOND_RESULT);
    expect(await fresh.claimTool(SEND)).toEqual({ kind: 'settled', result: FIRST_RESULT });

    // Still scoped to the one call it was ever about.
    expect(await fresh.claimTool(SEND_OTHER_ARGS)).toEqual(CLAIMED);
    expect(await fresh.claimTool(OTHER_CALL)).toEqual(CLAIMED);
    expect(await fresh.claimTool(NEXT_TURN)).toEqual(CLAIMED);
  });
});
