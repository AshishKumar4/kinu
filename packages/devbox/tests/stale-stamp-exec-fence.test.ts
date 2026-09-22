// A stale restore attempt must not write its boot id into a successor's container: the file
// and durable row would disagree, and the heartbeat would count a phantom replacement.
import { describe, expect, test } from 'bun:test';

import * as v from 'valibot';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, gate, harness } from './support/devbox-harness';

const BOOT_ID_KEY = 'devbox:boot-id';

const BOOT_ID_PATH = '/tmp/devbox-boot-id';

const StampedBootIdSchema = v.string();

/** Counted, not inferred from the surviving value: a write then a repair leaves the
 *  same final byte as no write, hiding the window between them. */
const stamps = (container: { readonly execs: readonly string[] }): readonly string[] =>
  container.execs.filter(
    command => command.startsWith('printf %s ') && command.endsWith(BOOT_ID_PATH),
  );

/** Shipped policy with a short port probe so a parked attempt resolves fast; this is the
 *  production box, not a budget box. */
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

    const durable = v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY));
    // Read through the harness path: the `container.bootId = undefined` above
    // narrows the direct property reference for the whole scope.
    expect(harnessed.container.bootId).toBe(durable);
    expect((await box.devboxState()).replacedCount).toBe(0);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('an attempt superseded BEFORE the exec writes nothing into that container', async () => {
    // Parks at the stamp's durable read, not its exec, so the attempt reaches the container
    // write with the generation already gone; a post-write repair leaves the file wrong.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    const reading = gate();
    // Parked after the stamp captured the old id and saw it absent, so resumption cannot
    // adopt the successor's id instead of exercising the pre-exec ownership fence.
    rows.set(BOOT_ID_KEY, 'retired-boot');
    storage.gateOn('devbox:replaced-count', reading);
    const stale = box.devboxStartup();
    await reading.reached;

    await container.stop();
    await box.devboxStartup();
    const durable = v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY));

    reading.release();
    await stale;

    expect(stamps(harnessed.container)).toEqual([`printf %s ${durable} > ${BOOT_ID_PATH}`]);
    expect(harnessed.container.bootId).toBe(durable);
    expect((await box.devboxState()).replacedCount).toBe(1);
    expect((await box.devboxState()).ready).toBe(true);
  });
});
