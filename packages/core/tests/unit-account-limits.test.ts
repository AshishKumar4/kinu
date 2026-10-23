/**
 * An account's limits (core limits/), decided on what its object keeps: only something new is refused, each refusal
 * says what is full and offers the ways on, and nobody but a free account on a deployment with a free tier is bound.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  accountClassOf, AccountLimitsStore, admitComputerStart, admitPlatformTurn, admitStoredBytes, admitWorkspace,
  DEFAULT_FREE_TIER, freeTierOf, initAccountLimitTables, limitsReport, type AccountUse, type Admission,
} from '../src/limits/index';
import { evalAccountEmail } from '../src/cloud-wire';
import { makeSqlExec } from './helpers';
import { ADMISSION_REFUSAL_MARK } from '../src/turn-failure';

const NOW = Date.UTC(2026, 9, 23, 12);

const fresh = () => {
  const db = new Database(':memory:');
  const sql = makeSqlExec(db);

  initAccountLimitTables(sql);

  return { store: new AccountLimitsStore(sql), close: () => { db.close(); } };
};

const use = (over: Partial<AccountUse> = {}): AccountUse => ({ workspaces: 0, computerSeconds: 0, running: [], storedBytes: 0, tokensToday: 0, ...over });

const free = (over: Partial<AccountUse> = {}): Admission => ({ klass: 'free', tier: DEFAULT_FREE_TIER, use: use(over), now: NOW });

describe("a free account's limits refuse only something new", () => {
  test('a fourth workspace is refused, naming the three and the ways on; the third is not', () => {
    expect(admitWorkspace(free({ workspaces: 2 }))).toBeNull();
    const refused = admitWorkspace(free({ workspaces: 3 }));

    expect(refused?.code).toBe('budget');
    expect(refused?.message).toContain('3 free workspaces');
    expect(refused?.message).toContain('/deploy');
    expect(refused?.message).toContain('Settings → Backup');
  });

  test('past 2 GB stored, a new workspace and a new upload are refused; under it, neither is', () => {
    const over = free({ storedBytes: 2 * 1024 ** 3 });

    expect(admitStoredBytes(free({ storedBytes: 2 * 1024 ** 3 - 1 }))).toBeNull();
    expect(admitStoredBytes(over)?.message).toContain('2.0 GB');
    expect(admitWorkspace(over)?.message).toContain('a new workspace cannot be added');
  });

  test('a computer starts small and alone, within 20 hours a month; one already running is never asked', () => {
    const other = { workspace: 'other', size: 'small', started_at: NOW, last_tick_at: NOW };
    const running = [other];

    expect(admitComputerStart(free(), { workspace: 'here', size: 'small' })).toBeNull();
    expect(admitComputerStart(free(), { workspace: 'here', size: 'medium' })?.message).toContain('Set it to small');
    expect(admitComputerStart(free({ running }), { workspace: 'here', size: 'small' })?.message).toContain('running in other');
    expect(admitComputerStart(free({ computerSeconds: 20 * 3600 }), { workspace: 'here', size: 'small' })?.message).toContain('2026-11-01');
    // Its own place held: a recovery restart or a resize continues.
    expect(admitComputerStart(free({ running: [{ ...other, workspace: 'here' }], computerSeconds: 30 * 3600 }), { workspace: 'here', size: 'small' })).toBeNull();
  });

  test("past the day's tokens a platform turn is refused, offering the person's own model; the mark keeps it unretried", () => {
    expect(admitPlatformTurn(free({ tokensToday: 499_999 }))).toBeNull();
    const refused = admitPlatformTurn(free({ tokensToday: 500_000 }));

    expect(refused?.message).toContain('Settings → Models');
    expect(refused?.message.startsWith(ADMISSION_REFUSAL_MARK)).toBe(true);
  });

  test('an operator, an invited and an eval account meet none of them', () => {
    const full = use({ workspaces: 9, storedBytes: 9 * 1024 ** 3, computerSeconds: 99 * 3600, tokensToday: 9_000_000 });

    for (const klass of ['operator', 'invited', 'eval'] as const) {
      const admission = { klass, tier: DEFAULT_FREE_TIER, use: full, now: NOW };

      expect([admitWorkspace(admission), admitStoredBytes(admission), admitPlatformTurn(admission), admitComputerStart(admission, { workspace: 'w', size: 'large' })]).toEqual([null, null, null, null]);
      expect(limitsReport(admission, null).limits).toEqual([]);
    }
  });
});

describe('who an account is', () => {
  const devEmail = 'eval-service@kinu.run';

  test('the eval identity and its named accounts are exempt, but the limits account is free', () => {
    const standing = { class: 'free', invitedBy: null, invitedAt: null, suspended: null } as const;

    expect(accountClassOf({ email: devEmail, operator: false, devEmail, standing })).toBe('eval');
    expect(accountClassOf({ email: evalAccountEmail(devEmail, 'devices'), operator: false, devEmail, standing })).toBe('eval');
    expect(accountClassOf({ email: evalAccountEmail(devEmail, 'limits'), operator: false, devEmail, standing })).toBe('free');
    expect(accountClassOf({ email: 'someone@example.com', operator: true, devEmail, standing })).toBe('operator');
  });

  test("a deployment's free tier is opt-in, its numbers overridable, and a malformed one never reads as none", () => {
    expect(freeTierOf(undefined)).toBeNull();
    expect(freeTierOf('{}')).toEqual(DEFAULT_FREE_TIER);
    expect(freeTierOf('{"workspaces":5}')).toEqual({ ...DEFAULT_FREE_TIER, workspaces: 5 });
    expect(freeTierOf('{"workspace":5}')).toBe('malformed');
  });
});

describe("the account's own counts", () => {
  test("a computer's hours accrue per tick, at most two beats a tick, and a stop frees its place", () => {
    const { store, close } = fresh();

    store.started('w', 'small', NOW);
    store.tick('w', 'small', NOW + 60_000);
    // A gap of an hour (the platform stopped it unseen) counts two beats, not the hour.
    store.tick('w', 'small', NOW + 3_660_000);
    store.stopped('w', NOW + 3_690_000);
    expect(store.computerSeconds(NOW)).toBe(60 + 120 + 30);
    expect(store.running(NOW + 3_690_000)).toEqual([]);
    close();
  });

  test("stored bytes are each store's last reading, a removed one forgotten; tokens count to their UTC day", () => {
    const { store, close } = fresh();

    store.sampled('workspace:a', 100, NOW);
    store.sampled('drive', 50, NOW);
    store.sampled('workspace:a', 70, NOW + 1);
    expect(store.storedBytes()).toBe(120);
    store.forgetStore('workspace:a');
    expect(store.storedBytes()).toBe(50);
    store.spentTokens(300, NOW);
    store.spentTokens(200, NOW + 12 * 3600_000);
    expect([store.tokensToday(NOW), store.tokensToday(NOW + 12 * 3600_000)]).toEqual([300, 200]);
    close();
  });

  test('the assistant mentions a near limit once a period', () => {
    const { store, close } = fresh();

    expect([store.noticeOnce('model_tokens', '2026-10-23', NOW), store.noticeOnce('model_tokens', '2026-10-23', NOW)]).toEqual([true, false]);
    expect(store.noticeOnce('model_tokens', '2026-10-24', NOW)).toBe(true);
    close();
  });
});
