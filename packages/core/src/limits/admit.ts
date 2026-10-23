/**
 * Whether an account may start one new thing, and the words when it may not. Each refusal says what is full, what
 * frees it, and the two ways on that need nothing freed: the person's own model (for the model cap), and their own
 * Kinu at /deploy, with Move my data in Settings to bring their data. A refusal is a `budget` KinuError: work that never began.
 */
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { ADMISSION_REFUSAL_MARK } from '../turn-failure';
import { COMPUTER_SIZE_ORDER, isLimited, LIMIT_IDS, type AccountClass, type ComputerSize, type FreeTier } from './policy';
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
const OWN_KINU = 'or run your own Kinu with no limits at /deploy (Move my data, in Settings under Account, downloads your data to bring along).';

const GB = 1024 ** 3;

/** Bytes as a person reads them: `1.4 GB`, `2 GB`, `820 MB`. */
export function shownBytes(bytes: number): string {
  return bytes >= GB ? `${String(Number((bytes / GB).toFixed(1)))} GB` : `${String(Math.round(bytes / 1024 ** 2))} MB`;
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
 * `workspace`'s computer starting from stopped: the account's only one running, and within the month's hours. A computer
 * already running is never asked. Its size never refuses it: it starts at {@link startSize}.
 */
export function admitComputerStart({ klass, tier, use, now }: Admission, workspace: string): KinuError | null {
  // A box that already holds its place (a recovery restart, a resize) continues: only a start from stopped is asked.
  if (use.running.some((running) => running.workspace === workspace)) return null;

  if (!isLimited(klass)) return null;

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
 * The size a computer set to `size` starts at: a free account's at most the tier's (the owner, 2026-10-23: what an
 * account already has keeps working, at the free size). Only the start is sized so; the setting stays as it was set,
 * and an account an operator invites starts at it again.
 */
export function startSize({ klass, tier }: Pick<Admission, 'klass' | 'tier'>, size: ComputerSize): ComputerSize {
  if (!isLimited(klass)) return size;

  return COMPUTER_SIZE_ORDER.indexOf(size) > COMPUTER_SIZE_ORDER.indexOf(tier.computerSize) ? tier.computerSize : size;
}

/**
 * A turn on one of the platform's own models: within the day's tokens. Led by the admission mark, so the turn is never
 * retried as a transient failure (turn-failure.ts).
 */
export function admitPlatformTurn({ klass, tier, use }: Admission): KinuError | null {
  if (!isLimited(klass) || use.tokensToday < tier.modelTokensPerDay) return null;

  return refused(`${ADMISSION_REFUSAL_MARK}: today's free model use is spent (${use.tokensToday.toLocaleString('en-US')} of `
    + `${tier.modelTokensPerDay.toLocaleString('en-US')} tokens); it starts again at 00:00 UTC. To go on now, connect ChatGPT or Claude, `
    + `or add an API key, in Settings under Models, ${OWN_KINU}`);
}

/** What a refusal is about, as the person's page asks of it: the limit, or the account's suspension. */
export type RefusedFor = 'workspaces' | 'stored_bytes' | 'computer' | 'model_tokens' | 'suspended';

/**
 * Each refusal this module and the account's object write, by its own words: the page that asked for something new
 * knows from them which limit refused it, and shows that limit's dialog. Each is matched anywhere in the text, as a
 * refusal crosses objects and the computer's start in words of its own around it.
 */
const REFUSED_BY: readonly (readonly [RegExp, RefusedFor])[] = [
  [/This account has its \d+ free workspaces\./u, 'workspaces'],
  [/This account stores [\d.]+ [GM]B, past its free/u, 'stored_bytes'],
  [/This account's free computer is running in|This account's computers have run their free/u, 'computer'],
  [/today's free model use is spent/u, 'model_tokens'],
  [/This account is suspended: /u, 'suspended'],
];

/** The limit a refusal's text says refused it; null for anything else. */
export function refusedFor(text: string): RefusedFor | null {
  return REFUSED_BY.find(([words]) => words.test(text))?.[1] ?? null;
}

/** One limit as Settings → Usage shows it. `near` from 80% used. */
const LimitReadingSchema = v.object({
  id: v.picklist(LIMIT_IDS),
  used: v.number(),
  limit: v.number(),
  unit: v.picklist(['count', 'seconds', 'bytes', 'tokens']),
  /** When the use starts again from nothing; null for a limit that never resets. */
  resetsAt: v.nullable(v.number()),
  near: v.boolean(),
  reached: v.boolean(),
});

export type LimitReading = v.InferOutput<typeof LimitReadingSchema>;

/** What the account is, and each of its limits read now; an unlimited account has no readings. */
export const LimitsReportSchema = v.object({
  class: v.picklist(['operator', 'invited', 'eval', 'free']),
  suspended: v.nullable(v.object({ at: v.number(), reason: v.string() })),
  limits: v.array(LimitReadingSchema),
  /** The largest size the account's computers start at, whatever size is set ({@link startSize}); null for no cap. */
  computerSizeCap: v.nullable(v.picklist(COMPUTER_SIZE_ORDER)),
});

export type LimitsReport = v.InferOutput<typeof LimitsReportSchema>;

/** The share of a limit past which the person is told it is near (the owner, 2026-10-23). */
const NEAR_SHARE = 0.8;

function reading(read: Omit<LimitReading, 'near' | 'reached'>): LimitReading {
  return { ...read, near: read.used >= read.limit * NEAR_SHARE, reached: read.used >= read.limit };
}

/** The account's use against each of the free tier's limits, whatever its class binds. */
export function limitReadings({ tier, use, now }: Omit<Admission, 'klass'>): LimitReading[] {
  return [
    reading({ id: 'workspaces', used: use.workspaces, limit: tier.workspaces, unit: 'count', resetsAt: null }),
    reading({ id: 'computer_hours', used: use.computerSeconds, limit: tier.computerHoursPerMonth * 3600, unit: 'seconds', resetsAt: periodEnd('month', now) }),
    reading({ id: 'computers_running', used: use.running.length, limit: tier.computersRunning, unit: 'count', resetsAt: null }),
    reading({ id: 'stored_bytes', used: use.storedBytes, limit: tier.storedBytes, unit: 'bytes', resetsAt: null }),
    reading({ id: 'model_tokens', used: use.tokensToday, limit: tier.modelTokensPerDay, unit: 'tokens', resetsAt: periodEnd('day', now) }),
  ];
}

export function limitsReport(admission: Admission, suspended: LimitsReport['suspended']): LimitsReport {
  const { klass } = admission;

  const limited = isLimited(klass);

  return { class: klass, suspended, limits: limited ? limitReadings(admission) : [], computerSizeCap: limited ? admission.tier.computerSize : null };
}

/**
 * An account as the operators' accounts table reads it: its report, and `use`, its use against the free tier's limits
 * whatever its class, which an unlimited account's report leaves out; empty where the deployment has no free tier.
 */
export const AccountLimitsSchema = v.object({
  report: LimitsReportSchema,
  use: v.array(LimitReadingSchema),
});

export type AccountLimits = v.InferOutput<typeof AccountLimitsSchema>;
