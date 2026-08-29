/**
 * The durable device-command ledger across a REAL activation reset.
 *
 * Three claims, each of which a green bun suite cannot make (see
 * ./device-inflight-probe.ts for why):
 *
 *   1. A claim an activation died holding does not strand the request. The
 *      claim is activation-scoped, and the next activation is what expires it.
 *   2. The first stored answer survives the reset. A confirmed stop is still
 *      confirmed afterwards, and a second authority reports THAT answer instead
 *      of killing a command that is already dead.
 *   3. The acknowledgement is ordered against the row it acknowledges. An
 *      eviction between reading the row and deleting it leaves the record
 *      intact, so the daemon's retained result stays replayable rather than
 *      being dropped by a delete that outlived its read.
 *
 * Every statement here is the production ledger's. This file asserts what real
 * Durable Object storage and a real reset do to it.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** A stub held across a reset is itself broken by the reset; the id survives.
 *  Re-acquiring is what a real caller does on its next request. */
const probe = (name: string) => env.DEVICE_LEDGER_PROBE.get(env.DEVICE_LEDGER_PROBE.idFromName(name));

const TURN = 'turn-1';

describe('a cancellation claim the activation died holding', () => {
  it('is expired by the next activation, and the request is live work again', async () => {
    const request = 'rpc-workerdprobe-1';
    await probe('abandoned-claim').admit(request, TURN);

    // A sweep claims the row and is interrupted before it can store an answer:
    // exactly where an eviction hurts, because the claim is what hides the row
    // from every other authority.
    const claimed = await probe('abandoned-claim').claimTurn(TURN);
    expect(claimed).toMatchObject([{ requestId: request, settled: null }]);
    expect(claimed[0].claim).not.toBe('');
    // A second sweep in the SAME activation sees nothing: the claim is
    // exclusive, which is the negative control for the reset below.
    expect(await probe('abandoned-claim').claimTurn(TURN)).toEqual([]);

    await abortAllDurableObjects();

    // The row survived with its answer still absent, and the fresh activation
    // released the dead claim rather than leaving a request nothing can reach.
    const reclaimed = await probe('abandoned-claim').claimTurn(TURN);
    expect(reclaimed).toMatchObject([{ requestId: request, settled: null }]);
    expect(reclaimed[0].claim).not.toBe(claimed[0].claim);

    // And the claim the dead activation held speaks for nothing now.
    expect(await probe('abandoned-claim').held(request, claimed[0].claim)).toBeNull();
    expect(await probe('abandoned-claim').settle(request, claimed[0].claim, 'terminated')).toBeNull();
  });
});

describe('the first stored answer', () => {
  it('survives the reset, and the next authority reports it instead of killing again', async () => {
    const request = 'rpc-workerdprobe-2';
    await probe('first-writer').admit(request, TURN);
    const claimed = await probe('first-writer').claimTurn(TURN);

    // The kill was confirmed. The answer is stored BEFORE the acknowledgement,
    // because the acknowledgement is the step that can fail.
    expect(await probe('first-writer').settle(request, claimed[0].claim, 'terminated')).toBe('terminated');
    // The acknowledgement fails, so the row stays with its answer.
    expect(await probe('first-writer').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: 'terminated' }]);

    await abortAllDurableObjects();

    // A later sweep finds the row settled: nothing runs under this request, so
    // it owes only its cleanup and must never be cancelled a second time.
    const later = await probe('first-writer').claimTurn(TURN);
    expect(later).toMatchObject([{ requestId: request, settled: 'terminated' }]);
    expect(await probe('first-writer').held(request, later[0].claim))
      .toEqual({ settled: 'terminated' });
    // A settled row is not work, so it cannot change hands either.
    expect(await probe('first-writer').transfer(request, 'job-1')).toEqual({ transferred: false });

    // Cleanup, once the daemon can be reached again, is the only step left.
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

    // The sweep read the row before sending its frame and saw no answer, so it
    // is now awaiting the device. While it waits, the tool aborting its own exec
    // stores the confirmed kill through the unclaimed path.
    await probe('answer-race').settleUnclaimed(request, 'terminated');

    // The sweep's own answer arrives late and is only a guess: the daemon holds
    // no control entry for a command that is already dead. The confirmed kill
    // must stand, and the sweep must report THAT — telling the owner a dead
    // command merely 'may have' stopped is the defect this pins.
    expect(await probe('answer-race').settle(request, claimed[0].claim, 'unknown'))
      .toBe('terminated');
    expect(await probe('answer-race').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: 'terminated' }]);

    await abortAllDurableObjects();

    // The reset does not launder the guess back in.
    expect(await probe('answer-race').claimTurn(TURN))
      .toMatchObject([{ requestId: request, settled: 'terminated' }]);
  });
});

describe('an acknowledgement interrupted between its read and its delete', () => {
  it('leaves the record intact, so the daemon result stays replayable', async () => {
    const request = 'rpc-workerdprobe-3';
    await probe('ack-ordering').admit(request, TURN);

    // The cloud read the row and acknowledged the daemon; the delete had not
    // happened yet when the activation ended.
    const held = await probe('ack-ordering').acknowledgeable(request);
    expect(held).toEqual({ deviceId: 'dev-probe' });

    await abortAllDurableObjects();

    // The row is still there: an activation reset between the two steps loses
    // nothing, and reconciliation still has a request to work from.
    expect(await probe('ack-ordering').rows())
      .toEqual([{ requestId: request, claim: '', settled: null }]);

    // The retry's delete is compare-guarded against the row it read, so it
    // removes exactly that record.
    await probe('ack-ordering').deleteAcknowledged(request, 'dev-probe');
    expect(await probe('ack-ordering').rows()).toEqual([]);
  });

  it('never deletes a replacement command that reused the request id', async () => {
    const request = 'rpc-workerdprobe-4';
    await probe('ack-replacement').admit(request, TURN);
    expect(await probe('ack-replacement').acknowledgeable(request)).toEqual({ deviceId: 'dev-probe' });

    // The row a cancellation now holds is not the row that was read, and the
    // acknowledgement's delete may not touch it.
    const claimed = await probe('ack-replacement').claimTurn(TURN);
    await probe('ack-replacement').deleteAcknowledged(request, 'dev-probe');
    expect(await probe('ack-replacement').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: null }]);
  });
});
