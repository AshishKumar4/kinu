/**
 * The production device-command ledger across a real Durable Object activation reset (bun cannot; see
 * ./device-inflight-probe.ts). Defends: a dead activation's claim strands the request, a stored answer is
 * lost or overwritten, or an interrupted acknowledgement deletes a still-replayable row.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** A stub held across a reset is broken by it; re-acquire from the id, as a real caller does. */
const probe = (name: string) => env.DEVICE_LEDGER_PROBE.get(env.DEVICE_LEDGER_PROBE.idFromName(name));

const TURN = 'turn-1';

describe('a cancellation claim the activation died holding', () => {
  it('is expired by the next activation, and the request is live work again', async () => {
    const request = 'rpc-workerdprobe-1';
    await probe('abandoned-claim').admit(request, TURN);

    // A sweep claims the row and is interrupted before storing an answer; the claim hides the row.
    const claimed = await probe('abandoned-claim').claimTurn(TURN);
    expect(claimed).toMatchObject([{ requestId: request, settled: null }]);
    expect(claimed[0].claim).not.toBe('');
    // Negative control: the claim is exclusive within one activation.
    expect(await probe('abandoned-claim').claimTurn(TURN)).toEqual([]);

    await abortAllDurableObjects();

    // The fresh activation released the dead claim.
    const reclaimed = await probe('abandoned-claim').claimTurn(TURN);
    expect(reclaimed).toMatchObject([{ requestId: request, settled: null }]);
    expect(reclaimed[0].claim).not.toBe(claimed[0].claim);

    expect(await probe('abandoned-claim').held(request, claimed[0].claim)).toBeNull();
    expect(await probe('abandoned-claim').settle(request, claimed[0].claim, 'terminated')).toBeNull();
  });
});

describe('the first stored answer', () => {
  it('survives the reset, and the next authority reports it instead of killing again', async () => {
    const request = 'rpc-workerdprobe-2';
    await probe('first-writer').admit(request, TURN);
    const claimed = await probe('first-writer').claimTurn(TURN);

    // The answer is stored before the acknowledgement, which is the step that can fail.
    expect(await probe('first-writer').settle(request, claimed[0].claim, 'terminated')).toBe('terminated');
    expect(await probe('first-writer').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: 'terminated' }]);

    await abortAllDurableObjects();

    // Settled: owes only cleanup and must never be cancelled a second time.
    const later = await probe('first-writer').claimTurn(TURN);
    expect(later).toMatchObject([{ requestId: request, settled: 'terminated' }]);
    expect(await probe('first-writer').held(request, later[0].claim))
      .toEqual({ settled: 'terminated' });
    expect(await probe('first-writer').transfer(request, 'job-1')).toEqual({ transferred: false });

    await probe('first-writer').deleteHeld(request, later[0].claim);
    expect(await probe('first-writer').rows()).toEqual([]);
  });
});

describe('an answer that lands while the sweep is still waiting on the device', () => {
  it('is the answer reported, not the sweep\'s later guess', async () => {
    const request = 'rpc-workerdprobe-4';
    await probe('answer-race').admit(request, TURN);
    const claimed = await probe('answer-race').claimTurn(TURN);
    expect(claimed).toMatchObject([{ requestId: request, settled: null }]);

    // While the sweep awaits the device, the tool's own abort stores the confirmed kill unclaimed.
    await probe('answer-race').settleUnclaimed(request, 'terminated');

    // The sweep's late `unknown` is a guess; reporting a dead command as 'may have' stopped is the defect pinned.
    expect(await probe('answer-race').settle(request, claimed[0].claim, 'unknown'))
      .toBe('terminated');
    expect(await probe('answer-race').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: 'terminated' }]);

    await abortAllDurableObjects();

    expect(await probe('answer-race').claimTurn(TURN))
      .toMatchObject([{ requestId: request, settled: 'terminated' }]);
  });
});

describe('an acknowledgement interrupted between its read and its delete', () => {
  it('leaves the record intact, so the daemon result stays replayable', async () => {
    const request = 'rpc-workerdprobe-3';
    await probe('ack-ordering').admit(request, TURN);

    // Acknowledged the daemon; the activation ended before the delete.
    const held = await probe('ack-ordering').acknowledgeable(request);
    expect(held).toEqual({ deviceId: 'dev-probe' });

    await abortAllDurableObjects();

    expect(await probe('ack-ordering').rows())
      .toEqual([{ requestId: request, claim: '', settled: null }]);

    // The retry's delete is compare-guarded against the row it read.
    await probe('ack-ordering').deleteAcknowledged(request, 'dev-probe');
    expect(await probe('ack-ordering').rows()).toEqual([]);
  });

  it('never deletes a replacement command that reused the request id', async () => {
    const request = 'rpc-workerdprobe-4';
    await probe('ack-replacement').admit(request, TURN);
    expect(await probe('ack-replacement').acknowledgeable(request)).toEqual({ deviceId: 'dev-probe' });

    // The acknowledgement's delete may not touch a row a cancellation now holds.
    const claimed = await probe('ack-replacement').claimTurn(TURN);
    await probe('ack-replacement').deleteAcknowledged(request, 'dev-probe');
    expect(await probe('ack-replacement').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: null }]);
  });
});
