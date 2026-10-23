/**
 * What an account may start on this deployment (the owner, 2026-10-23): a free account a small tier, an invited
 * account, an operator or an eval account none. A limit refuses only something new, a workspace, a computer start,
 * stored bytes, a platform-model turn: what the account already has stays usable.
 */
import * as v from 'valibot';

/** Who an account is, for its limits. Operator and eval are read from its email, never stored; invited is stored. */
export type AccountClass = 'operator' | 'invited' | 'eval' | 'free';

/** The classes a person's standing can be set to by an operator; the others follow from the email. */
export const STORED_CLASSES = ['free', 'invited'] as const;

export type StoredClass = (typeof STORED_CLASSES)[number];

/** Each limit by what it bounds. */
export const LIMIT_IDS = ['workspaces', 'computer_hours', 'computers_running', 'stored_bytes', 'model_tokens'] as const;

export type LimitId = (typeof LIMIT_IDS)[number];

/** The computer sizes a box starts at (devbox `BOX_SIZES`), smallest first. */
export const COMPUTER_SIZE_ORDER = ['small', 'medium', 'large'] as const;

export type ComputerSize = (typeof COMPUTER_SIZE_ORDER)[number];

/** The free tier, as numbers. Each is a count of new things it admits up to. */
export interface FreeTier {
  readonly workspaces: number;
  readonly computerHoursPerMonth: number;
  readonly computersRunning: number;
  readonly computerSize: ComputerSize;
  readonly storedBytes: number;
  readonly modelTokensPerDay: number;
}

/**
 * The owner's free tier (2026-10-23): about 3 workspaces, 1 small computer for about 20 hours a month, 2 GB stored, and
 * platform models up to a daily cap. The cap's number is the owner's to set; 500,000 tokens a day is the proposal.
 */
export const DEFAULT_FREE_TIER: FreeTier = {
  workspaces: 3,
  computerHoursPerMonth: 20,
  computersRunning: 1,
  computerSize: 'small',
  storedBytes: 2 * 1024 ** 3,
  modelTokensPerDay: 500_000,
};

const FreeTierOverrideSchema = v.strictObject({
  workspaces: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  computerHoursPerMonth: v.optional(v.pipe(v.number(), v.minValue(0))),
  computersRunning: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  computerSize: v.optional(v.picklist(COMPUTER_SIZE_ORDER)),
  storedBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  modelTokensPerDay: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

/**
 * The free tier on this deployment, from its `ACCOUNT_LIMITS` var: the owner's defaults, each overridden by the var's
 * own number (`{}` is the defaults). Unset is no free tier: a self-host's people are its operators and those it
 * invites, and nobody is bounded. A value that is not an object of known limits is the deployment's mistake, refused,
 * never read as no limits.
 */
export function freeTierOf(raw: string | undefined): FreeTier | null | 'malformed' {
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), FreeTierOverrideSchema), raw);

  return parsed.success ? { ...DEFAULT_FREE_TIER, ...parsed.output } : 'malformed';
}

/** Whether `klass` is bounded at all: only a free account is. */
export function isLimited(klass: AccountClass): boolean {
  return klass === 'free';
}
