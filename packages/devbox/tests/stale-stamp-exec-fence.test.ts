// KINU residual: a stale attempt parked at the boot-id stamp exec must not
// write its id into the successor's container.
//
// 983e81be fenced the stamp's two storage.put calls but left the container-file
// exec unfenced, so the exact interleave that commit describes — an attempt
// parks at the stamp exec while the container is replaced, the successor fully
// restores and stamps file+storage with ITS id, and the stale attempt then
// resumes — still ran `printf %s <stale-id> > /tmp/devbox-boot-id` into the
// successor's container while the fenced put stayed skipped. The file and the
// durable copy then disagree with no writer left to reconcile them, which the
// heartbeat's replacement detector reads as a mismatch on a HEALTHY container:
// the next beat re-drives a full restoration, counts a phantom replacement, and
// restarts supervised processes and port exposures for nothing.
//
// This file pins the exec to the same fence as the put. Red on 983e81be9's
// tree: there, the parked attempt's exec lands in the successor's container.
import { describe, expect, test } from 'bun:test';

import * as v from 'valibot';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, gate, harness } from './support/devbox-harness';

const BOOT_ID_KEY = 'devbox:boot-id';

const StampedBootIdSchema = v.string();

/** The shipped policy with a test-length probe, so a parked attempt is a fast
 * fact. This is the production box, not a budget box. */
class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get previewHost(): string | undefined {
    return 'preview.example';
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

describe('a stale attempt\'s stamp exec does not write the successor\'s container', () => {
  test('the container file keeps the successor\'s id, and the rows agree with it', async () => {
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    const parked = gate();
    container.stampGate = parked;
    const stale = box.devboxStartup();
    await parked.reached;
    // The generation turns over underneath the parked attempt, exactly as a
    // heartbeat that spots a replacement would do.
    await container.stop();
    container.bootId = undefined;
    const successor = box.devboxStartup();
    await successor;

    parked.release();
    await stale;

    // THE FENCE, container side: the file this container carries is the id the
    // successor stamped. A stale exec here is the half of the divergence the
    // heartbeat reads on the very next beat.
    const durable = v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY));
    // Read through the harness path: the `container.bootId = undefined` above
    // narrows the direct property reference for the whole scope.
    expect(harnessed.container.bootId).toBe(durable);
    expect((await box.devboxState()).replacedCount).toBe(0);
    expect((await box.devboxState()).ready).toBe(true);
  });
});
