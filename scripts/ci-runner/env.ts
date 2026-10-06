import type { CiEnvironments, CiPreparer } from './environments';
import type { CiRun } from './run';
import type { CiShard } from './shard';
import type { CiTimings } from './timings';

export interface Env {
  readonly CI_RUN: DurableObjectNamespace<CiRun>;
  readonly CI_SHARD: DurableObjectNamespace<CiShard>;
  readonly CI_ENVIRONMENTS: DurableObjectNamespace<CiEnvironments>;
  readonly CI_PREPARER: DurableObjectNamespace<CiPreparer>;
  readonly CI_TIMINGS: DurableObjectNamespace<CiTimings>;
  /** Commit packs, run plans, part verdicts and logs, collected verdicts and the timing history. */
  readonly ARTIFACTS: R2Bucket;
  /** The bearer `scripts/ci-remote.ts` presents (`~/.config/kinu/ci-token`). */
  readonly CI_TOKEN: string;
}

/** The R2 key of a commit's pack: its whole history (`root`), or what it adds to an environment's commit. */
export const packKey = (sha: string, base: string): string => `packs/${sha}.${base}.pack`;

/** The one instance of an account-wide object. */
export const SINGLE = 'all';
