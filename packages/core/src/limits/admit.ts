/**
 * Whether an account may start one new thing, and the words when it may not. Each refusal says what is full, what
 * frees it, and the two ways on that need nothing freed: the person's own model (for the model cap), and their own
 * Kinu at /deploy, with Settings → Backup to bring their data. A refusal is a `budget` KinuError: work that never began.
 */
import { KinuError } from '../obs/error';
import { ADMISSION_REFUSAL_MARK } from '../turn-failure';
import { COMPUTER_SIZE_ORDER, isLimited, type AccountClass, type ComputerSize, type FreeTier, type LimitId } from './policy';
import { periodEnd, type RunningComputer } from './store';

/** What of its limits an account has used, as its object reads it now. */
export interface AccountUse {
  readonly workspaces: number;
  readonly computerSeconds: number;
  readonly running: readonly RunningComputer[];
  readonly storedBytes: number;
  readonly tokensToday: number;
}

/** The way on that needs nothing freed, said the same at every limit. */
const OWN_KINU = 'or run your own Kinu with no limits at /deploy (Settings → Backup downloads your data to bring along).';

const GB = 1024 ** 3;

/** Bytes as a person reads them: `1.4 GB`, `820 MB`. */
export function shownBytes(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${String(Math.round(bytes / 1024 ** 2))} MB`;
}

/** Hours as a person reads them: `19.5 hours`. */
function shownHours(seconds: number): string {
  return `${(Math.round(seconds / 360) / 10).toFixed(1)} hours`;
}

function refused(text: string): KinuError {
  return new KinuError('budget', text);
}

/** Past the stored-bytes cap: no new workspace and no new upload. */
function storageRefusal(tier: FreeTier, use: AccountUse, adding: string): KinuError | null {
  if (use.storedBytes < tier.storedBytes) return null;

  return refused(`This account stores ${shownBytes(use.storedBytes)}, past its free ${shownBytes(tier.storedBytes)}, so ${adding} cannot be added. `
    + `Remove files or workspaces to make room, ${OWN_KINU}`);
}

/** What every admission is decided on: who the account is, the deployment's free tier, and the account's use now. */
export interface Admission {
  readonly klass: AccountClass;
  readonly tier: FreeTier;
  readonly use: AccountUse;
  readonly now: number;
}

/** A new workspace: under the count, and with room to store it. */
export function admitWorkspace({ klass, tier, use }: Admission): KinuError | null {
  if (!isLimited(klass)) return null;

  if (use.workspaces >= tier.workspaces) {
    return refused(`This account has its ${String(tier.workspaces)} free workspaces. Remove one to make another, ${OWN_KINU}`);
  }

  return storageRefusal(tier, use, 'a new workspace');
}

/** A new upload or file: with room to store it. */
export function admitStoredBytes({ klass, tier, use }: Admission): KinuError | null {
  return isLimited(klass) ? storageRefusal(tier, use, 'new files') : null;
}

/**
 * `workspace`'s computer starting from stopped at `size`: small, the account's only one running, and within the month's
 * hours. A computer already running is never asked.
 */
export function admitComputerStart({ klass, tier, use, now }: Admission, start: { readonly workspace: string; readonly size: ComputerSize }): KinuError | null {
  const { workspace, size } = start;

  // A box that already holds its place (a recovery restart, a resize) continues: only a start from stopped is asked.
  if (use.running.some((running) => running.workspace === workspace)) return null;

  if (!isLimited(klass)) return null;

  if (COMPUTER_SIZE_ORDER.indexOf(size) > COMPUTER_SIZE_ORDER.indexOf(tier.computerSize)) {
    return refused(`A free account's computer is ${tier.computerSize}; this one is set to ${size}. Set it to ${tier.computerSize} to start it, ${OWN_KINU}`);
  }

  const others = use.running.filter((running) => running.workspace !== workspace);
  const [other] = others;

  if (other !== undefined && others.length >= tier.computersRunning) {
    return refused(`This account's free computer is running in ${other.workspace}. Stop it there to start one here, ${OWN_KINU}`);
  }

  if (use.computerSeconds >= tier.computerHoursPerMonth * 3600) {
    const resets = new Date(periodEnd('month', now)).toISOString().slice(0, 10);

    return refused(`This account's computers have run their free ${String(tier.computerHoursPerMonth)} hours this month (${shownHours(use.computerSeconds)}); `
      + `the hours start again on ${resets}. Until then, ${OWN_KINU}`);
  }

  return null;
}

/**
 * A turn on one of the platform's own models: within the day's tokens. Led by the admission mark, so the turn is never
 * retried as a transient failure (turn-failure.ts).
 */
export function admitPlatformTurn({ klass, tier, use }: Admission): KinuError | null {
  if (!isLimited(klass) || use.tokensToday < tier.modelTokensPerDay) return null;

  return refused(`${ADMISSION_REFUSAL_MARK}: today's free model use is spent (${use.tokensToday.toLocaleString('en-US')} of `
    + `${tier.modelTokensPerDay.toLocaleString('en-US')} tokens); it starts again at 00:00 UTC. To go on now, connect ChatGPT or Claude, `
    + `or add an API key, in Settings → Models, ${OWN_KINU}`);
}

/** One limit as Settings → Usage shows it. `near` from 80% used. */
export interface LimitReading {
  readonly id: LimitId;
  readonly used: number;
  readonly limit: number;
  readonly unit: 'count' | 'seconds' | 'bytes' | 'tokens';
  /** When the use starts again from nothing; null for a limit that never resets. */
  readonly resetsAt: number | null;
  readonly near: boolean;
  readonly reached: boolean;
}

/** What the account is, and each of its limits read now; an unlimited account has no readings. */
export interface LimitsReport {
  readonly class: AccountClass;
  readonly suspended: { readonly at: number; readonly reason: string } | null;
  readonly limits: readonly LimitReading[];
}

/** The share of a limit past which the person is told it is near (the owner, 2026-10-23). */
export const NEAR_SHARE = 0.8;

function reading(read: Omit<LimitReading, 'near' | 'reached'>): LimitReading {
  return { ...read, near: read.used >= read.limit * NEAR_SHARE, reached: read.used >= read.limit };
}

export function limitsReport({ klass, tier, use, now }: Admission, suspended: LimitsReport['suspended']): LimitsReport {
  if (!isLimited(klass)) return { class: klass, suspended, limits: [] };

  return {
    class: klass,
    suspended,
    limits: [
      reading({ id: 'workspaces', used: use.workspaces, limit: tier.workspaces, unit: 'count', resetsAt: null }),
      reading({ id: 'computer_hours', used: use.computerSeconds, limit: tier.computerHoursPerMonth * 3600, unit: 'seconds', resetsAt: periodEnd('month', now) }),
      reading({ id: 'computers_running', used: use.running.length, limit: tier.computersRunning, unit: 'count', resetsAt: null }),
      reading({ id: 'stored_bytes', used: use.storedBytes, limit: tier.storedBytes, unit: 'bytes', resetsAt: null }),
      reading({ id: 'model_tokens', used: use.tokensToday, limit: tier.modelTokensPerDay, unit: 'tokens', resetsAt: periodEnd('day', now) }),
    ],
  };
}
