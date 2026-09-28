/**
 * A 5 MiB overwrite of the user's file parks on the owner and lands on approval, on real Durable Object storage: a
 * turn holding all its bytes at once is what resets an object, which bun:sqlite never does.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const MIB = 1024 * 1024;

describe('a large overwrite of the user\u2019s file with nobody there to answer', () => {
  it('parks on its bytes and writes exactly them on approval, in one incarnation of the object', async () => {
    const probe = env.PARKED_WRITES_PROBE.get(env.PARKED_WRITES_PROBE.idFromName('five-mib'));

    const parked = await probe.park(5 * MIB);
    expect(parked.error).toContain('queued for owner approval');
    expect(parked.queued).toHaveLength(1);
    expect(parked.parkedFiles).toBe(1);
    expect(parked.fileSha).not.toBe(parked.askedSha);

    const approved = await probe.approve();
    expect(approved).toMatchObject({ incarnation: parked.incarnation, queued: [], fileSha: parked.askedSha, parkedFiles: 0 });
  });
});
