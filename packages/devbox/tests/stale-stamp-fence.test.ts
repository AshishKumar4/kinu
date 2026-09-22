// Pins the ownership fence at `#stampBootId`: a stale attempt's stamp must not overwrite
// the successor's `BOOT_ID_KEY`, which the heartbeat's replacement detector reads.
import { describe, expect, test } from 'bun:test';

import * as v from 'valibot';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, gate, harness } from './support/devbox-harness';

const BOOT_ID_KEY = 'devbox:boot-id';

/** The stamped row, parsed rather than asserted: a boot id the box wrote that
 *  is not a string is a defect worth failing on, not one to cast past. */
const StampedBootIdSchema = v.string();

/** Shipped policy with a short port probe so a parked attempt resolves fast; budgets stay
 *  default because the fence under test is not about budget exhaustion. */
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

describe('a stale attempt\'s boot-id stamp does not overwrite the successor\'s', () => {
  test('a stamp parked on the stale attempt never regresses the newer boot id', async () => {
    // The park is the stamp exec, the last await before the durable boot-id write; without
    // the fence both writes land after the successor has fully settled.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    const parked = gate();
    container.stampGate = parked;
    const stale = box.devboxStartup();
    await parked.reached;
    // The generation turns over underneath the parked attempt, exactly as a
    // heartbeat that spots a replacement would do.
    await container.stop();
    const successor = box.devboxStartup();
    await successor;
    const successorBootId = v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY));

    parked.release();
    await stale;

    // A stale attempt must not regress the live generation's boot id: the heartbeat
    // would read the mismatch and replace a healthy container.
    expect(v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY))).toBe(successorBootId);
    expect((await box.devboxState()).replacedCount).toBe(0);
    expect((await box.devboxState()).ready).toBe(true);
  });
});
