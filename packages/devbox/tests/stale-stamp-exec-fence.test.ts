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
// It pins the OTHER side of the same await pair too. Ownership can be lost at
// the stamp's FIRST await — the durable read of BOOT_ID_KEY — so an attempt can
// reach the exec already knowing its generation moved. Writing there and
// repairing afterwards is not the same as not writing: between the two execs the
// container file disagrees with the durable row, and `#containerWasReplaced`
// compares exactly those two values, so a heartbeat landing in that window
// re-drives a whole restoration and counts a phantom replacement against a
// container that is healthy.
//
// Red on 983e81be9's tree for the parked-exec case, and on 4a7b92037's for the
// already-superseded one: there the stale attempt writes its own id in, then
// writes the successor's back over it.
import { describe, expect, test } from 'bun:test';

import * as v from 'valibot';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, gate, harness } from './support/devbox-harness';

const BOOT_ID_KEY = 'devbox:boot-id';
const BOOT_ID_PATH = '/tmp/devbox-boot-id';

const StampedBootIdSchema = v.string();

/** Every boot-id write this container was asked to make, in order.
 *
 *  Counted rather than inferred from the surviving value: a write followed by a
 *  repair leaves the same final byte as no write at all, and the window between
 *  them is the defect. */
const stamps = (container: { readonly execs: readonly string[] }): readonly string[] =>
  container.execs.filter(
    command => command.startsWith('printf %s ') && command.endsWith(BOOT_ID_PATH),
  );

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

  test('an attempt superseded BEFORE the exec writes nothing into that container', async () => {
    // Parked at the stamp's durable read instead of at its exec, so the attempt
    // arrives at the container write with the generation already gone. The
    // repair above cannot help here: it runs AFTER a write that should never
    // have been issued, and the file is wrong for the whole gap between them.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    const reading = gate();
    storage.gateOn(BOOT_ID_KEY, reading);
    const stale = box.devboxStartup();
    await reading.reached;

    await container.stop();
    await box.devboxStartup();
    const durable = v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY));

    reading.release();
    await stale;

    // ONE write in this container's whole life, and it is the successor's. The
    // stale mint and the repair that follows it are the two this fence refuses.
    expect(stamps(harnessed.container)).toEqual([`printf %s ${durable} > ${BOOT_ID_PATH}`]);
    expect(harnessed.container.bootId).toBe(durable);
    expect((await box.devboxState()).replacedCount).toBe(0);
    expect((await box.devboxState()).ready).toBe(true);
  });
});
