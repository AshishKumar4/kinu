/**
 * The account's limits (core limits/), kept in its own object: each new thing its workspaces start is asked here
 * first, and what they spend or hold is reported here. A refusal is the account's word, said in core's words.
 */
import { Effect } from 'effect';
import { KinuError, settle, settleSync } from '@kinu.run/core/obs';
import {
  accountClassOf, admitComputerStart, admitPlatformTurn, admitStoredBytes, admitWorkspace, AccountLimitsStore, dayOf,
  freeTierOf, isLimited, limitReadings, startSize, limitsReport, monthOf, type AccountClass, type AccountLimits, type AccountUse, type Admission,
  type ComputerSize, type FreeTier, type LimitId, type LimitReading, type LimitsReport, type StoredClass, type UserCaller,
} from '@kinu.run/core';
import { isListedOperator } from '../control-plane/admin-caller';
import type { UserObjectHost } from './user-host';

export interface UserLimitsHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  /** The account's workspaces as its roster counts them (workspaces.ts `rosterCount`). */
  workspaceCount(): number;
  /** The bytes the account's Drive holds, as its tenant accounts them (drive/tenant.ts `driveStoredBytes`). */
  driveBytes(): Promise<number>;
  /** The bytes the account's mail holds, its database and its R2 objects (MailboxDO `storedBytes`). */
  mailBytes(): Promise<number>;
}

/**
 * How old the account's own stores' readings may be before an admission reads them again. Each workspace reports its
 * own size as its turns open and as files arrive; the Drive and the mail are read here.
 */
const STORAGE_STALE_MS = 10 * 60_000;

/** The note the assistant gives once a period, when a limit is near its end; a limit with none is not mentioned. */
const NEAR_NOTE = {
  workspaces: (shown: string) => `This account has used ${shown} of its free workspaces.`,
  computer_hours: (shown: string) => `This account's computers have run ${shown} of their free hours this month.`,
  stored_bytes: (shown: string) => `This account stores ${shown} of its free space.`,
  model_tokens: (shown: string) => `Today's free model use is at ${shown}.`,
} satisfies Partial<Record<LimitId, (shown: string) => string>>;

const isNoted = (id: LimitId): id is keyof typeof NEAR_NOTE => id in NEAR_NOTE;

/** The period a near limit is mentioned once in: its own for one that resets, else for as long as its number holds. */
function noticePeriod(limit: LimitReading, now: number): string {
  if (limit.id === 'model_tokens') return dayOf(now);

  return limit.id === 'computer_hours' ? monthOf(now) : `at:${String(Math.floor(limit.limit))}`;
}

export class UserLimits {
  private readonly store: AccountLimitsStore;

  constructor(private readonly host: UserLimitsHost) {
    this.store = new AccountLimitsStore(host.ctx.storage.sql);
  }

  private email(): string {
    return this.host.sqlx<{ email: string }>('SELECT email FROM user_profile WHERE id = 1')[0]?.email ?? '';
  }

  /** The deployment's free tier; null where it has none. A malformed one refuses every new thing, saying so. */
  private tier(): Effect.Effect<FreeTier | null, KinuError> {
    const tier = freeTierOf(this.host.env.ACCOUNT_LIMITS);

    return tier === 'malformed'
      ? Effect.fail(new KinuError('unavailable', "This deployment's ACCOUNT_LIMITS is not an object of known limits; nothing new starts until it is mended."))
      : Effect.succeed(tier);
  }

  /** Why an operator suspended the account, or null. */
  suspension(): string | null {
    return this.store.standing().suspended?.reason ?? null;
  }

  klass(): AccountClass {
    const email = this.email();

    return accountClassOf({ email, operator: isListedOperator(this.host.env, email), devEmail: this.host.env.DEV_USER_EMAIL ?? '', standing: this.store.standing() });
  }

  private use(now: number): AccountUse {
    return {
      workspaces: this.host.workspaceCount(),
      computerSeconds: this.store.computerSeconds(now),
      running: this.store.running(now),
      storedBytes: this.store.storedBytes(),
      tokensToday: this.store.tokensToday(now),
    };
  }

  /**
   * Each admission: suspended first (nothing new starts in a suspended account), then the free tier where the deployment
   * has one and the account is bound by it.
   */
  private admit(decide: (admission: Admission) => KinuError | null): Effect.Effect<void, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const { suspended } = this.store.standing();

      if (suspended !== null) return yield* new KinuError('denied', `This account is suspended: ${suspended.reason}`);
      const tier = yield* this.tier();

      if (tier === null) return;
      const now = Date.now();
      const refusal = decide({ klass: this.klass(), tier, use: this.use(now), now });

      if (refusal !== null) return yield* refusal;
    });
  }

  /**
   * A new workspace, asked synchronously inside the roster's own turn (workspaces.ts), between its read and its write, so
   * nothing else runs between them and no second create races it.
   */
  admitWorkspace(): void {
    settleSync(this.admit(admitWorkspace));
  }

  /** New bytes: `own`, the asking workspace's size as it reads it now, is taken first; the account's stores read if stale. */
  async admitStoredBytes(caller: UserCaller, own?: { readonly source: string; readonly bytes: number }): Promise<void> {
    await this.host.requireTier(caller, 'limits');

    if (own !== undefined) this.store.sampled(own.source, own.bytes, Date.now());
    await this.admitNewBytes();
  }

  /** New bytes from this object's own surfaces (a Drive upload): the account's stores read if stale, then the limit. */
  async admitNewBytes(): Promise<void> {
    await this.refreshStorage();
    await settle(this.admit(admitStoredBytes));
  }

  /** `source` changed here (a Drive upload landed): read again at the next admission or Usage read. */
  storeChanged(source: 'drive' | 'mail'): void {
    this.store.stale(source);
  }

  /**
   * `workspace`'s computer starting from stopped, set to `size`: admitted, it holds the account's place until it stops,
   * and starts at the size answered, a free account's at most the tier's.
   */
  async admitComputerStart(caller: UserCaller, workspace: string, size: ComputerSize): Promise<ComputerSize> {
    await this.host.requireTier(caller, 'limits');
    await settle(this.admit((admission) => admitComputerStart(admission, workspace)));
    const tier = await settle(this.tier());
    const runs = tier === null ? size : startSize({ klass: this.klass(), tier }, size);

    this.store.started(workspace, runs, Date.now());

    return runs;
  }

  async computerTick(caller: UserCaller, workspace: string, size: ComputerSize): Promise<void> {
    await this.host.requireTier(caller, 'limits');
    this.store.tick(workspace, size, Date.now());
  }

  async computerStopped(caller: UserCaller, workspace: string): Promise<void> {
    await this.host.requireTier(caller, 'limits');
    this.store.stopped(workspace, Date.now());
  }

  /** A workspace's own size, read where it lives (its object's database): `workspace:<name>`. */
  async storageSampled(caller: UserCaller, source: string, bytes: number): Promise<void> {
    await this.host.requireTier(caller, 'limits');
    this.store.sampled(source, bytes, Date.now());
  }

  /** Whether the account is bound by a free tier here: only then is anything read before an admission. */
  private bound(): boolean {
    const tier = freeTierOf(this.host.env.ACCOUNT_LIMITS);

    return tier !== null && (tier === 'malformed' || isLimited(this.klass()));
  }

  /**
   * The Drive's and the mail's sizes read again where they live, each whose last reading is past {@link STORAGE_STALE_MS},
   * for an account a free tier binds; `always` for a reading the person asked to see.
   */
  async refreshStorage(always = false): Promise<void> {
    if (!always && !this.bound()) return;
    const now = Date.now();
    const stale = (source: string): boolean => now - (this.store.measuredAt(source) ?? 0) > STORAGE_STALE_MS;
    const [drive, mail] = await Promise.all([stale('drive') ? this.host.driveBytes() : null, stale('mail') ? this.host.mailBytes() : null]);

    if (drive !== null) this.store.sampled('drive', drive, now);

    if (mail !== null) this.store.sampled('mail', mail, now);
  }

  /** A removed workspace's size counts no more (workspaces.ts teardown). */
  forgetStore(source: string): void {
    this.store.forgetStore(source);
  }

  /**
   * A turn of one of the account's agents: refused in a suspended account, and, on one of the platform's own models
   * (`platform`), past the day's tokens. A turn on the person's own key or login meets no free-tier limit.
   */
  async admitTurn(caller: UserCaller, platform: boolean): Promise<void> {
    await this.host.requireTier(caller, 'limits');
    await settle(this.admit((admission) => (platform ? admitPlatformTurn(admission) : null)));
  }

  /** Tokens (input and output) a platform-model step spent, from the binding's own usage. */
  async platformTokensSpent(caller: UserCaller, tokens: number): Promise<void> {
    await this.host.requireTier(caller, 'limits');
    this.store.spentTokens(tokens, Date.now());
  }

  async limits(caller: UserCaller): Promise<LimitsReport> {
    await this.host.requireTier(caller, 'limits');
    await this.refreshStorage(true);
    const now = Date.now();
    const { suspended } = this.store.standing();
    const tier = await settle(this.tier());
    const klass = this.klass();
    const shown = suspended === null ? null : { at: suspended.at, reason: suspended.reason };

    return tier === null ? { class: klass, suspended: shown, limits: [], computerSizeCap: null } : limitsReport({ klass, tier, use: this.use(now), now }, shown);
  }

  /** The account as the operators' accounts table reads it: its report, and its use whatever its class binds. */
  async account(caller: UserCaller): Promise<AccountLimits> {
    const report = await this.limits(caller);
    const now = Date.now();
    const tier = await settle(this.tier());

    return { report, use: tier === null ? [] : limitReadings({ tier, use: this.use(now), now }) };
  }

  /**
   * The assistant's one note of limits near their end: each near limit not yet mentioned this period, recorded as said.
   * Null when there is nothing new to say.
   */
  async nearNote(caller: UserCaller): Promise<string | null> {
    const report = await this.limits(caller);
    const now = Date.now();

    const notes = report.limits.flatMap((limit) => {
      const note = isNoted(limit.id) ? NEAR_NOTE[limit.id] : undefined;

      if (note === undefined || !limit.near || !this.store.noticeOnce(limit.id, noticePeriod(limit, now), now)) return [];

      return [note(`${String(Math.round((limit.used / Math.max(limit.limit, 1)) * 100))}%`)];
    });

    return notes.length === 0 ? null : `${notes.join(' ')} At the limit only new things stop; the person can see each limit in Settings → Usage.`;
  }

  // The operator plane's (control-plane routes, as the owner capability, audited there).

  async setClass(caller: UserCaller, klass: StoredClass, by: string): Promise<void> {
    await this.host.requireTier(caller, 'limits.manage');
    this.store.setClass(klass, by, Date.now());
  }

  async suspend(caller: UserCaller, reason: string, by: string): Promise<void> {
    await this.host.requireTier(caller, 'limits.manage');
    this.store.suspend(reason, by, Date.now());
  }

  async unsuspend(caller: UserCaller): Promise<void> {
    await this.host.requireTier(caller, 'limits.manage');
    this.store.unsuspend(Date.now());
  }

  /** An invite link `by` made, spent by this account (the person's own route, after the control plane spent it). */
  async inviteRedeemed(caller: UserCaller, by: string): Promise<void> {
    await this.host.requireTier(caller, 'limits.manage');

    if (this.store.standing().class !== 'invited') this.store.setClass('invited', by, Date.now());
  }
}
