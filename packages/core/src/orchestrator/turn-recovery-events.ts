/** Disruption rows: a dead activation's open turn resumed, or settled by recovery. */
import { diagnostics } from '../obs/index';

/** `unknown` when either side recorded no build (a scaffold program records none). */
export type SameBuild = 'yes' | 'no' | 'unknown';

export function sameBuildOf(admitted: string | null | undefined, installed: string | null): SameBuild {
  if (admitted === null || admitted === undefined || installed === null) return 'unknown';

  return admitted === installed ? 'yes' : 'no';
}

export function recordTurnResumed(input: {
  readonly actor: string;
  /** 0 for a turn that restarts from its input. */
  readonly stepsKept: number;
  readonly midStep: boolean;
  readonly sameBuild: SameBuild;
}): void {
  diagnostics.event('turn.resumed', input);
}

export function recordRecoverySettled(input: {
  readonly actor: string;
  readonly cause: 'record_unreadable' | 'stalled' | 'unverified';
  readonly sameBuild: SameBuild;
}): void {
  diagnostics.event('turn.recovery_settled', input);
}
