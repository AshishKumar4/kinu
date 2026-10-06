/**
 * CiTimings: what the runner measured, kept to size the next plan. A graded run reports each green row's seconds and
 * each file's; a red or hung row reports nothing, so a hang never becomes a row's estimate. The ladder reads the
 * medians as `--ci-costs` over the hosted `scripts/ci-cost.json`.
 */
import { DurableObject } from 'cloudflare:workers';
import { medians, recordSamples, type Timings } from './contract';
import type { Env } from './env';

interface History {
  readonly sha: string;
  readonly runId: string;
  readonly seconds: Record<string, number[]>;
  readonly files: Record<string, number[]>;
}

/** The `HostedCosts` shape the ladder reads, from no measurement yet: every estimate is then the hosted one. */
export interface RunnerCosts {
  readonly version: 1;
  readonly sha: string;
  readonly runUrl: string;
  readonly seconds: Record<string, number>;
  readonly files: Record<string, number>;
}

export class CiTimings extends DurableObject<Env> {
  async record(timings: Timings): Promise<void> {
    const history = await this.ctx.storage.get<History>('history');

    await this.ctx.storage.put('history', {
      sha: timings.sha,
      runId: timings.runId,
      seconds: recordSamples(history?.seconds ?? {}, timings.seconds),
      files: recordSamples(history?.files ?? {}, timings.files),
    } satisfies History);
  }

  async costs(sha: string): Promise<RunnerCosts> {
    const history = await this.ctx.storage.get<History>('history');

    return {
      version: 1,
      sha: history?.sha ?? sha,
      runUrl: `kinu-ci-runner ${history?.runId ?? 'none'}`,
      seconds: medians(history?.seconds ?? {}),
      files: medians(history?.files ?? {}),
    };
  }
}
