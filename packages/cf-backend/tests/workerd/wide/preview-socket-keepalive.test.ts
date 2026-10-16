/**
 * A preview's WebSocket holds its resident while it stays open, quiet or not (Kinu's Nimbus patch, NIMBUS-ASKS #43): worker
 * 0.16 holds a resident only for 60 s after client traffic, so a page holding a quiet socket lost the server behind it. Through
 * the production workspace object, its preview edge, and a slate's own `/__rpc` socket, with the object's clock moved
 * past that hold and its alarms delivered. The slate's `evaluation` names the evaluation of its module that answers.
 */
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

/** Past worker 0.16's hold on a resident after its last client traffic (`RESIDENT_KEEPALIVE_DETACHED_MS`, 60 s). */
const PAST_TRAFFIC_BOUND_MS = 61_000;

it('an open, quiet preview socket keeps the same application serving past the traffic bound, relays both ways, and lets go once closed', async () => {
  const subject = env.SLATE_DURABILITY_PROBE.get(env.SLATE_DURABILITY_PROBE.idFromName('preview-keepalive'));
  const workspace = 'preview-keepalive';
  const boot = await subject.serveSlate({ workspace, owner: 'keepalive-owner', id: 'held', body: 'held-body' });
  // The workspace's armed keep-alive of its resident, as Nimbus names the task (`HostedRuntimeTask`).
  const keepalives = async () => (await subject.pendingNimbusTasks(workspace)).tasks.map((task) => task.id).filter((id) => id === 'resident-keepalive');

  expect(await subject.holdPreview(boot.url)).toEqual({ ok: true });

  try {
    // A call out over the socket and its answer back.
    expect(await subject.callHeldPreview('ping')).toEqual({ ok: true, value: '{"rows":1}' });
    const serving = await subject.callHeldPreview('evaluation');

    // No frame at all, well past the bound, with every alarm due delivered. Red without the hold on the routed socket.
    for (let quiet = 0; quiet < 3; quiet += 1) {
      await subject.advanceClock(PAST_TRAFFIC_BOUND_MS);
      await subject.wakeOnce(workspace);
    }

    expect(await subject.callHeldPreview('evaluation')).toEqual(serving);
    expect(await subject.callHeldPreview('ping')).toEqual({ ok: true, value: '{"rows":2}' });
    expect(await keepalives()).toEqual(['resident-keepalive']);
    expect(await subject.closeHeldPreview()).toEqual({ code: 1001 });

    // Closed, the socket holds nothing: past the bound after its close the resident's keep-alive ends and arms no
    // successor. Red when a close releases nothing.
    for (let quiet = 0; quiet < 2; quiet += 1) {
      await subject.advanceClock(PAST_TRAFFIC_BOUND_MS);
      await subject.wakeOnce(workspace);
    }

    expect(await keepalives()).toEqual([]);
  } finally {
    await subject.restoreClock();
  }
});
