/**
 * `claimToolEffect`/`settleToolEffect` over real Durable Object SQLite across real isolate deaths.
 * Defends: once-only tool effects; `indeterminate` is only reachable when an activation dies between
 * claim and settle, and `abortAllDurableObjects()` exists only in workerd.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProbeToolCall } from './terminal-effect-probe';

/** A stub held across a reset is broken by it; re-acquire from the surviving id. */
const probe = (name: string) =>
  env.TERMINAL_EFFECT_PROBE.get(env.TERMINAL_EFFECT_PROBE.idFromName(name));

const SEND: ProbeToolCall = {
  turnId: 'u-claim',
  callId: 'call_send_1',
  tool: 'send_email',
  args: { to: 'ada@example.com', subject: 'once' },
};

/** The digest is part of the key: a reissued call id over new arguments must not get the old outcome. */
const SEND_OTHER_ARGS: ProbeToolCall = {
  ...SEND,
  args: { to: 'grace@example.com', subject: 'once' },
};

const OTHER_CALL: ProbeToolCall = { ...SEND, callId: 'call_send_2' };

/** Claims are per turn. */
const NEXT_TURN: ProbeToolCall = { ...SEND, turnId: 'u-claim-next' };

const FIRST_RESULT = '{"delivered":true,"id":"msg-1"}';

const SECOND_RESULT = '{"delivered":true,"id":"msg-2-a-replay-must-never-record"}';

const CLAIMED = { kind: 'claimed', result: null };

const REFUSED = { kind: 'indeterminate', result: null };

describe('a tool effect claimed on an isolate that dies before settling', () => {
  /** A claimed-and-unsettled row may or may not have had its effect, so the harness refuses. */
  it('reports indeterminate to the next activation, not claimed', async () => {
    const stub = probe('tool-claim-refusal');

    expect(await stub.claimTool(SEND)).toEqual(CLAIMED);

    await abortAllDurableObjects();

    const fresh = probe('tool-claim-refusal');
    expect(await fresh.claimTool(SEND)).toEqual(REFUSED);
    // Reporting `indeterminate` must not leave the row claimable.
    expect(await fresh.claimTool(SEND)).toEqual(REFUSED);

    expect(await fresh.claimTool(SEND_OTHER_ARGS)).toEqual(CLAIMED);
    expect(await fresh.claimTool(OTHER_CALL)).toEqual(CLAIMED);
    expect(await fresh.claimTool(NEXT_TURN)).toEqual(CLAIMED);
  });
});

describe('a tool effect settled after the eviction that interrupted it', () => {
  /**
   * First writer wins: the settle is an UPDATE guarded on an absent result. The second eviction makes the
   * read a statement about the disk, not the activation that wrote it.
   */
  it('keeps the first result, and a duplicate settle cannot overwrite it', async () => {
    const stub = probe('tool-claim-first-writer');

    expect(await stub.claimTool(SEND)).toEqual(CLAIMED);

    await abortAllDurableObjects();

    const recovered = probe('tool-claim-first-writer');
    expect(await recovered.claimTool(SEND)).toEqual(REFUSED);

    await recovered.settleTool(SEND, FIRST_RESULT);
    await recovered.settleTool(SEND, SECOND_RESULT);
    expect(await recovered.claimTool(SEND)).toEqual({ kind: 'settled', result: FIRST_RESULT });

    await abortAllDurableObjects();

    const fresh = probe('tool-claim-first-writer');
    // A replayed call returns this instead of running: the once-only guarantee.
    expect(await fresh.claimTool(SEND)).toEqual({ kind: 'settled', result: FIRST_RESULT });
    await fresh.settleTool(SEND, SECOND_RESULT);
    expect(await fresh.claimTool(SEND)).toEqual({ kind: 'settled', result: FIRST_RESULT });

    expect(await fresh.claimTool(SEND_OTHER_ARGS)).toEqual(CLAIMED);
    expect(await fresh.claimTool(OTHER_CALL)).toEqual(CLAIMED);
    expect(await fresh.claimTool(NEXT_TURN)).toEqual(CLAIMED);
  });
});
