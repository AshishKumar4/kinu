/** Disruption rows: a dead activation's open turn resumed, or settled. */
import { diagnostics } from '../obs/index';

/** `unknown`: a side recorded no build. */
export type SameBuild = 'yes' | 'no' | 'unknown';

export function sameBuildOf(admitted: string | null | undefined, installed: string | null): SameBuild {
  if (admitted === null || admitted === undefined || installed === null) return 'unknown';

  return admitted === installed ? 'yes' : 'no';
}

export function recordTurnResumed(input: {
  readonly workspace: string;
  readonly actor: string;
  /** 0 for a kind that restarts from its input (hosted, today). */
  readonly stepsKept: number;
  readonly midStep: boolean;
  readonly sameBuild: SameBuild;
}): void {
  diagnostics.event('turn.resumed', input);
}

export function recordRecoverySettled(input: {
  readonly workspace: string;
  readonly actor: string;
  readonly cause: 'stopped' | 'record_unreadable' | 'stalled' | 'unverified';
  readonly sameBuild: SameBuild;
}): void {
  diagnostics.event('turn.recovery_settled', input);
}
