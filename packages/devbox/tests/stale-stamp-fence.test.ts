// Pins the ownership fence at `#stampBootId`: a stale attempt's stamp must not overwrite
// the successor's `BOOT_ID_KEY`, which the heartbeat's replacement detector reads.
import { TestDevbox } from './support/test-devbox';
import { describe, expect, test } from 'bun:test';

import * as v from 'valibot';

import { gate, harness } from './support/devbox-harness';

const BOOT_ID_KEY = 'devbox:boot-id';

/** The stamped row, parsed rather than asserted: a boot id the box wrote that
 *  is not a string is a defect worth failing on, not one to cast past. */
const StampedBootIdSchema = v.string();

/** Shipped policy with a short port probe so a parked attempt resolves fast; budgets stay
 *  default because the fence under test is not about budget exhaustion. */
class TestBox extends TestDevbox<unknown> {

  protected override get previewHost(): string | undefined {
    return 'preview.example';
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

describe('a stale attempt\'s boot-id stamp does not overwrite the successor\'s', () => {
  test('a stamp parked on the stale attempt never regresses the newer boot id', async () => {
    // A box whose last container the platform replaced: its row names a kernel that is gone, so the stamp reads the
    // replacement count after it reads the kernel. That read is where the stale attempt parks, holding its kernel's id.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    rows.set(BOOT_ID_KEY, 'a-kernel-the-platform-replaced');
    const parked = gate();
    storage.gateOn('devbox:replaced-count', parked);
    const stale = box.devboxStartup();
    await parked.reached;
    // The generation turns over underneath the parked attempt, exactly as a
    // heartbeat that spots a replacement would do.
    await container.stop();
    const successor = box.devboxStartup();
    await successor;
    const successorBootId = v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY));
    const counted = (await box.devboxState()).replacedCount;

    parked.release();
    await stale;

    // A stale attempt must not regress the live generation's boot id, nor count a replacement it no longer owns: the
    // heartbeat would read the mismatch and replace a healthy container.
    expect(v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY))).toBe(successorBootId);
    expect(container.bootId).toBe(successorBootId);
    expect((await box.devboxState()).replacedCount).toBe(counted);
    expect((await box.devboxState()).ready).toBe(true);
  });
});
