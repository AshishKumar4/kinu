/**
 * A preview's WebSocket holds its resident while it stays open, quiet or not (Kinu's Nimbus patch, NIMBUS-ASKS #43): 0.17
 * holds a resident only for 60 s after client traffic, so a page holding a quiet socket lost the server behind it. Through
 * the production workspace object, its preview edge, and a slate's own `/__rpc` socket. The keep-alive is an alarm task,
 * so each look is that alarm, with the object's clock moved past the task's due time.
 */
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const KEEPALIVE = 'resident-keepalive';

/** Past 0.17's hold on a resident after its last client traffic (`RESIDENT_KEEPALIVE_DETACHED_MS`, 60 s). */
const PAST_TRAFFIC_BOUND_MS = 61_000;

/** The keep-alive task's own period (`RESIDENT_KEEPALIVE_MS`, 5 s): its next run is due. */
const NEXT_RUN_MS = 5_000;

it('an open, quiet preview socket holds its slate past the traffic bound, relays both ways, and lets go once closed', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('preview-keepalive'));
  const workspace = 'preview-keepalive';
  const boot = await subject.serveSlate({ workspace, owner: 'keepalive-owner', id: 'held', body: 'held-body' });

  expect(await subject.holdPreview(boot.url)).toEqual({ ok: true });

  try {
    // A call out over the socket and its answer back.
    expect(await subject.callHeldPreview('ping')).toEqual({ ok: true, value: '{"rows":1}' });

    // No frame at all, three bounds over. Red without the runtime's hold on the routed socket.
    for (const bound of [1, 2, 3]) {
      await subject.advanceClock(PAST_TRAFFIC_BOUND_MS);
      expect(await subject.wakeOnce(workspace), `quiet bound ${String(bound)}`).toContain(KEEPALIVE);
    }

    expect(await subject.callHeldPreview('ping')).toEqual({ ok: true, value: '{"rows":2}' });
    expect(await subject.closeHeldPreview()).toEqual({ code: 1001 });

    // The close is client traffic: the resident is held for the bound after it, and then let go.
    await subject.advanceClock(NEXT_RUN_MS);
    expect(await subject.wakeOnce(workspace)).toContain(KEEPALIVE);
    await subject.advanceClock(PAST_TRAFFIC_BOUND_MS);
    expect(await subject.wakeOnce(workspace)).not.toContain(KEEPALIVE);
  } finally {
    await subject.restoreClock();
  }
});
