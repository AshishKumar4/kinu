// KINU-030 residual: a stale attempt's boot-id stamp must not overwrite the
// successor's durable boot identity.
//
// The fence says ownership is "asked after every await that precedes a state
// write" (devbox.ts, #owns). Every restoration phase honours it except one:
// `#stampBootId` performs TWO durable writes (`REPLACED_COUNT_KEY`'s read of
// `previous` and `BOOT_ID_KEY`) across awaits with NO ownership check. A stale
// attempt parked at its stamp exec — the same park the headline test uses —
// then runs its container write and its record write after the successor has
// already finished, overwriting the newer generation's boot id with an id for
// a container that no longer exists.
//
// The damage is not hypothetical: the heartbeat's replacement detector reads
// exactly this row (`BOOT_ID_KEY`) against the live container. A stale row
// makes the NEXT heartbeat read a mismatch on a healthy container and drive a
// spurious replacement — the churn the counting in `#stampBootId` exists to
// measure, caused by the stamp itself.
//
// This file pins the fence at the stamp. It is red on d05d40d19.
import { describe, expect, test } from 'bun:test';

import * as v from 'valibot';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { Devbox, gate, harness } from './support/devbox-harness';

const BOOT_ID_KEY = 'devbox:boot-id';

/** The stamped row, parsed rather than asserted: a boot id the box wrote that
 *  is not a string is a defect worth failing on, not one to cast past. */
const StampedBootIdSchema = v.string();

/** The shipped policy with a test-length probe, so a parked attempt is a fast
 * fact. This is the production box, not a budget box: the fence under test is
 * not about budget exhaustion. */
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
    // The park is the stamp exec, which is the LAST await before the durable
    // boot-id write. Both the container-side write and the durable write land
    // after the successor has fully settled if the fence is missing.
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

    // THE FENCE: the row the successor wrote is what the box keeps. A stale
    // attempt cannot regress the boot identity of a live generation —
    // otherwise the heartbeat reads the mismatch on the next beat and drives
    // a spurious replacement of a healthy container.
    expect(v.parse(StampedBootIdSchema, rows.get(BOOT_ID_KEY))).toBe(successorBootId);
    expect((await box.devboxState()).replacedCount).toBe(0);
    expect((await box.devboxState()).ready).toBe(true);
  });
});
