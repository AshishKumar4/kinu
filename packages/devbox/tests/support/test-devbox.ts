import { Devbox } from '../../src/devbox';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../../src/lifecycle';

/** Only the listener cadence is shortened; each scenario owns its other policies. */
export const TEST_DEVBOX_POLICY: DevboxPolicy = { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };

export class TestDevbox<Env = unknown> extends Devbox<Env> {
  protected override get policy(): DevboxPolicy {
    return TEST_DEVBOX_POLICY;
  }
}
