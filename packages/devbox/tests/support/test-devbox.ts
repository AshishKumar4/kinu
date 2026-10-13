import { Effect } from 'effect';
import { Devbox } from '../../src/devbox';
import type { DiskChain, DiskChainPorts } from '../../src/disk-chain';
import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../../src/lifecycle';

/** Only the listener cadence is shortened; each scenario owns its other policies. */
export const TEST_DEVBOX_POLICY: DevboxPolicy = { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };

const NO_DISK = 'this test box keeps no disk: its scenario is not about the chain';

/** A box whose disk chain keeps nothing: it attaches empty and every save is skipped. A test about the chain models it. */
export class TestDevbox<Env = unknown> extends Devbox<Env> {
  protected override get policy(): DevboxPolicy {
    return TEST_DEVBOX_POLICY;
  }

  protected override diskChain(_ports: DiskChainPorts): DiskChain {
    return {
      attach: () => Effect.succeed({ kind: 'empty', detail: NO_DISK, recoveredTo: undefined }),
      commit: () => Effect.succeed({ kind: 'skipped', reason: NO_DISK, bytes: undefined, movedBytes: 0 }),
    };
  }
}
