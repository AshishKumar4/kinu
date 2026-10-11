import { markStoreChanged } from '@kinu.run/agent-utils';
// AgentConfigStore: typed accessors over the `actor_config` key/value table.
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import type { SqlExecutor, SqlValue, RawSqlExec } from '../types/primitives';
import * as v from 'valibot';
import { nameOriginOf, type NameOrigin } from '../identity/naming';
import { isAccountName, isProviderScope } from '../credentials/accounts';
import { isReasoningEffort, type ReasoningEffort } from '../providers/reasoning-effort';
import { DEFAULT_ROLE_ID, isTierId, isValidRoleId, type RoleId, type TierId } from '../types/profile';
import {
  DEFAULT_CACHE_RETENTION, isCacheRetention, type CacheRetention,
} from '../providers/types';
import { formatApprovalGrant, parseApprovalGrant, type ApprovalGrant } from '../safety/approval-gate';
import {
  DEFAULT_ADVISOR_MIN_SEVERITY, isAdvisorSeverity, type AdvisorSeverity,
} from '../types/advisor';

export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Read a stored role-change policy. Unset or unknown reads as `allow`. */
export function parseRoleChangePolicy(value: string | null): 'allow' | 'approval' | 'locked' {
  return value === 'approval' || value === 'locked' ? value : 'allow';
}

/** Known config keys; each gets a typed getter/setter. */
export const AGENT_CONFIG_KEYS = {
  model: 'model',
  providerAccounts: 'provider_accounts',
  reasoningEffort: 'reasoning_effort',
  /** Prompt-cache prefix retention; unset means the provider default. */
  cacheRetention: 'cache_retention',
  displayName: 'display_name',
  /** 'user' once the operator names it explicitly; suppresses auto-titling. */
  nameOrigin: 'name_origin',
  /** The single role authority row; stores the bare catalog id. */
  roleSelection: 'role_selection',
  roleChangePolicy: 'role_change_policy',
  /** Tier a parent pinned at hire; unset means derive from the role. */
  assignedTier: 'assigned_tier',
  shellApprovalMode: 'shell_approval_mode',
  /** Comma-separated `<rule>@<executor>` grants; read live at exec time like the mode. */
  shellApprovalGrants: 'shell_approval_grants',
  sleepTimeCompute: 'sleep_time_compute',
  /** 'true' runs waiting edits as live trials on the main agent; off by default (docs/EVOLUTION-REDESIGN.md §5). */
  liveTrials: 'live_trials',
  /** 'true' once an agent hosted in its own isolate has submitted a plan there: Work asks only those isolates (D9). */
  holdsPlans: 'holds_plans',
  /** 'true' once the workspace's own agent ran a turn in its isolate: only then does that isolate hold runs or spend (D9). */
  holdsTurns: 'holds_turns',
  /** 'true' once an agent hosted in its own isolate has been offered `ask_owner` there: the stack asks only those isolates. */
  holdsQuestions: 'holds_questions',
  /** 'false' stops this agent learning from its turns: no ratings, struggles, lessons, proposals or trials. On by default. */
  learning: 'learning',
  advisorMinSeverity: 'advisor_min_severity',
  /** 'true' enables the turn reviewer; off by default since it costs a model call per turn. */
  advisorEnabled: 'advisor_enabled',
  alwaysActiveSkills: 'always_active_skills',
  /** Executor namespace of the last tool run; UI defaults to it. */
  lastActiveExecutor: 'last_active_executor',
  /** Epoch ms of the last Evolution Changelog view; newer entries drive the unseen badge. */
  changelogSeenAt: 'changelog_seen_at',
  closedTurnWindows: 'closed_turn_windows',
  /** 'false' silences owner emails; defaults on. */
  emailNotifications: 'email_notifications',

  /** Persisted because a boot counter misses reconstructions that reuse the isolate (e.g. `ctx.facets.abort()`). */
  isolateGen: 'isolate_gen',
  /** Canonical conversation id (config/conversation.ts); absent on first open, adopted as `default`. */
  conversationId: 'conversation.id',
  /** The root's chat title as the person set it; the workspace keeps its own name. */
  chatTitle: 'chat_title',
} as const;

/** Keys the shell-approval gate reads as authorization; a fork must not inherit them. Add any new gate key here. */
export const SHELL_APPROVAL_AUTHORITY_KEYS: readonly string[] = [
  AGENT_CONFIG_KEYS.shellApprovalMode,
  AGENT_CONFIG_KEYS.shellApprovalGrants,
];

export interface AgentConfigStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string, ...others: string[]): void;
  /** All rows; used by fork.ts to copy state. */
  all(): Record<string, string>;

  getModel(): string | null;
  setModel(spec: string): void;
  getProviderAccounts(): Readonly<Record<string, string>>;
  /** Null clears it: the profile's default applies. */
  setProviderAccount(provider: string, account: string | null): void;
  getReasoningEffort(): ReasoningEffort | null;
  /** Null clears the setting: the tier's level applies again. */
  setReasoningEffort(effort: ReasoningEffort | null): void;
  /** Unset or malformed reads as the `short` default. */
  getCacheRetention(): CacheRetention;
  setCacheRetention(retention: CacheRetention): void;
  getDisplayName(): string | null;
  setDisplayName(name: string): void;
  getNameOrigin(): NameOrigin | null;
  setNameOrigin(origin: NameOrigin): void;
  /** Title and origin in one SQLite statement. */
  setDisplayNameOrigin(name: string, origin: NameOrigin): void;
  /** Absent or invalid reads as `task`; the read writes nothing. */
  getRoleSelection(): RoleId;
  setRoleSelection(roleId: RoleId): void;
  /** Null derives the tier from the role at the child's turn boundary. */
  getAssignedTier(): TierId | null;
  setAssignedTier(tier: TierId | null): void;
  /** Unset reads as `allow`. */
  getRoleChangePolicy(): 'allow' | 'approval' | 'locked';
  setRoleChangePolicy(policy: 'allow' | 'approval' | 'locked'): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): void;
  /** Standing (rule, executor) grants; they stop the gate asking, never widen reach. */
  getShellApprovalGrants(): ApprovalGrant[];
  /** Idempotent. */
  grantShellApproval(grants: readonly ApprovalGrant[]): void;
  /** Unknown grants are ignored so a double-submitting UI is safe. */
  revokeShellApproval(grants: readonly ApprovalGrant[]): void;
  getSleepTimeComputeEnabled(): boolean;
  setSleepTimeComputeEnabled(enabled: boolean): void;
  getLiveTrials(): boolean;
  setLiveTrials(enabled: boolean): void;
  getHoldsPlans(): boolean;
  setHoldsPlans(): void;
  getHoldsTurns(): boolean;
  setHoldsTurns(): void;
  getHoldsQuestions(): boolean;
  setHoldsQuestions(): void;
  getLearning(): boolean;
  setLearning(enabled: boolean): void;
  getAdvisorEnabled(): boolean;
  setAdvisorEnabled(enabled: boolean): void;
  /** Unset or unknown reads as `concern`. */
  getAdvisorMinSeverity(): AdvisorSeverity;
  setAdvisorMinSeverity(severity: AdvisorSeverity): void;
  getAlwaysActiveSkills(): string[];
  setAlwaysActiveSkills(names: ReadonlyArray<string>): void;
  getLastActiveExecutor(): string | null;
  /** Ignores values that are not a plausible executor namespace. */
  setLastActiveExecutor(name: string): void;
  /** 0 = never seen. */
  getChangelogSeenAt(): number;
  setChangelogSeenAt(ms: number): void;
  countClosedTurnWindow(): number;
  /** Called once per activation; a gap between spans on one `selfPath` is a positive reset signal. */
  countIsolateGeneration(): number;
  getEmailNotificationsEnabled(): boolean;
  setEmailNotificationsEnabled(enabled: boolean): void;
  getChatTitle(): string | null;
  setChatTitle(title: string): void;
}

export function initAgentConfigTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_config (
    actor_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (actor_id, key)
  )`);
}

/** Where a database's config stores read `actor_config`. A store says `changed` before each write it makes. */
interface ConfigReads {
  value(actorId: string, key: string): string | null;
  all(actorId: string): Record<string, string>;
  changed(actorId: string): void;
}

/** A question per read: a database other processes also write (the CLI's file) can hold nothing between them. */
function liveConfigReads(sql: SqlExecutor): ConfigReads {
  return {
    value: (actorId, key) => sql<{ value: string }>`
      SELECT value FROM actor_config WHERE actor_id = ${actorId} AND key = ${key} LIMIT 1`[0]?.value ?? null,
    all: (actorId) => Object.fromEntries(sql<{ key: string; value: string }>`SELECT key, value FROM actor_config WHERE actor_id = ${actorId}`
      .map((row) => [row.key, row.value])),
    changed: () => undefined,
  };
}

/** One `actor_config` row, as an isolate's snapshot carries it. */
export type ConfigRow = { readonly actor_id: string; readonly key: string; readonly value: string };

const ConfigRowSchema = v.object({ actor_id: v.string(), key: v.string(), value: v.string() });

/**
 * Each actor's whole `actor_config`, held from one read: a key it lacks is unset, and its default needs no statement.
 * Every store over its executor reads through it and drops the actor's rows before it writes. The two other writers
 * say so: an isolate adopting its workspace's rows ({@link adopt}), and a fork emptying its target ({@link configReplaced}).
 */
class ConfigCatalog implements ConfigReads {
  private readonly held = new Map<string, ReadonlyMap<string, string>>();

  constructor(private readonly sql: SqlExecutor) {}

  private rows(actorId: string): ReadonlyMap<string, string> {
    const held = this.held.get(actorId);

    if (held !== undefined) return held;

    const rows = new Map(this.sql<{ key: string; value: string }>`SELECT key, value FROM actor_config WHERE actor_id = ${actorId}`
      .map((row) => [row.key, row.value]));

    this.held.set(actorId, rows);

    return rows;
  }

  value(actorId: string, key: string): string | null {
    return this.rows(actorId).get(key) ?? null;
  }

  all(actorId: string): Record<string, string> {
    return Object.fromEntries(this.rows(actorId));
  }

  changed(actorId: string): void {
    this.held.delete(actorId);
  }

  clear(): void {
    this.held.clear();
  }

  /** The rows of `actorIds`, those not held read in one statement. */
  stored(actorIds: readonly string[]): ConfigRow[] {
    const missing = actorIds.filter((actorId) => !this.held.has(actorId));

    if (missing.length > 0) {
      const read = this.sql<{ actor_id: string; key: string; value: string }>`SELECT actor_id, key, value FROM actor_config
        WHERE actor_id IN (SELECT value FROM json_each(${JSON.stringify(missing)}))`;

      for (const actorId of missing) this.held.set(actorId, new Map(read.filter((row) => row.actor_id === actorId).map((row) => [row.key, row.value])));
    }

    return actorIds.flatMap((actorId) => [...this.rows(actorId)].map(([key, value]) => ({ actor_id: actorId, key, value })));
  }

  /** After an adoption committed: `rows` are now every row of `actorIds`. */
  adopt(actorIds: readonly string[], rows: readonly Readonly<Record<string, SqlValue>>[]): void {
    const parsed = rows.map((row) => v.parse(ConfigRowSchema, row));

    for (const actorId of actorIds) this.held.set(actorId, new Map(parsed.filter((row) => row.actor_id === actorId).map((row) => [row.key, row.value])));
  }
}

const held = new WeakMap<SqlExecutor, ConfigCatalog>();

/**
 * The one catalog of the database `sql` executes on, held from now on by every config store over `sql`. Only for a
 * database `sql` alone writes, a Durable Object's: the CLI's file has other processes, and its stores ask per read.
 */
export function holdConfig(sql: SqlExecutor): ConfigCatalog {
  const catalog = held.get(sql) ?? new ConfigCatalog(sql);

  held.set(sql, catalog);

  return catalog;
}

/** A writer other than a store replaced `actor_config` rows through `sql`: a held catalog reads them again. */
export function configReplaced(sql: SqlExecutor): void {
  held.get(sql)?.clear();
}

export function createAgentConfigStore(sql: SqlExecutor, actorId: string, authorize: () => void): AgentConfigStore {
  const live = liveConfigReads(sql);
  // Asked per call: a store made before its database's catalog was held must still drop what it writes.
  const reads = (): ConfigReads => held.get(sql) ?? live;

  const get = (key: string): string | null => {
    authorize();

    return reads().value(actorId, key);
  };

  const set = (key: string, value: string): void => {
    authorize();
    reads().changed(actorId);
    void sql`INSERT INTO actor_config (actor_id, key, value) VALUES (${actorId}, ${key}, ${value})
        ON CONFLICT(actor_id, key) DO UPDATE SET value = excluded.value`;

    if (key === AGENT_CONFIG_KEYS.liveTrials || key === AGENT_CONFIG_KEYS.learning || key === AGENT_CONFIG_KEYS.changelogSeenAt) markStoreChanged(sql);
  };

  const remove = (key: string, ...others: string[]): void => {
    authorize();
    const keys = [key, ...others];
    reads().changed(actorId);
    void sql`DELETE FROM actor_config WHERE actor_id = ${actorId}
      AND key IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`;

    if (keys.some((name) => name === AGENT_CONFIG_KEYS.liveTrials || name === AGENT_CONFIG_KEYS.learning || name === AGENT_CONFIG_KEYS.changelogSeenAt)) markStoreChanged(sql);
  };

  const setValid = (key: string, value: string, valid: boolean, what: string): Effect.Effect<void> =>
    valid ? Effect.sync(() => set(key, value)) : Effect.die(new Error(`Invalid ${what}: ${value}`));

  /** The read writes nothing, so an unread row stays distinguishable from a stored `task`. */
  const readRoleSelection = (): RoleId => {
    const stored = get(AGENT_CONFIG_KEYS.roleSelection);

    return stored !== null && isValidRoleId(stored) ? stored : DEFAULT_ROLE_ID;
  };

  /** Single upsert-RETURNING so two stores cannot mint the same value; unparseable rows count as 0. */
  const increment = (key: string): number => {
    authorize();
    reads().changed(actorId);

    const rows = sql<{ value: string }>`
      INSERT INTO actor_config (actor_id, key, value) VALUES (${actorId}, ${key}, ${'1'})
      ON CONFLICT(actor_id, key) DO UPDATE SET value = CASE
        WHEN CAST(actor_config.value AS REAL) > 0 THEN CAST(CAST(actor_config.value AS REAL) AS INTEGER) + 1
        ELSE 1 END
      RETURNING value`;

    return Number(rows[0]?.value ?? 1);
  };

  /** Parses on read so malformed tokens are dropped on the next write. */
  const storedGrants = (): ApprovalGrant[] => {
    const raw = get(AGENT_CONFIG_KEYS.shellApprovalGrants) ?? '';

    return raw.split(',').map(parseApprovalGrant).filter((g) => g !== null);
  };

  const storedProviderAccounts = (): Record<string, string> => Object.fromEntries(
    (get(AGENT_CONFIG_KEYS.providerAccounts) ?? '').split(',').flatMap((pair) => {
      const at = pair.indexOf('=');
      const account = pair.slice(at + 1);

      return at > 0 && isAccountName(account) ? [[pair.slice(0, at), account]] : [];
    }),
  );

  const writeGrants = (grants: readonly ApprovalGrant[]): void => {
    const value = [...new Set(grants.map(formatApprovalGrant))].join(',');

    if (value.length === 0) remove(AGENT_CONFIG_KEYS.shellApprovalGrants);
    else set(AGENT_CONFIG_KEYS.shellApprovalGrants, value);
  };

  return {
    get,
    set,
    delete: remove,
    all() {
      authorize();

      return reads().all(actorId);
    },
    getModel() { return get(AGENT_CONFIG_KEYS.model); },
    setModel(spec) { set(AGENT_CONFIG_KEYS.model, spec); },
    getProviderAccounts: storedProviderAccounts,
    setProviderAccount(provider, account) {
      if (!isProviderScope(provider)) return settleSync(Effect.die(new Error(`Invalid provider id: ${provider}`)));

      if (account !== null && !isAccountName(account)) return settleSync(Effect.die(new Error(`Invalid account name: ${account}`)));
      const next = { ...storedProviderAccounts(), [provider]: account };
      const pairs = Object.entries(next).flatMap(([id, name]) => (name === null ? [] : [`${id}=${name}`])).sort();

      if (pairs.length === 0) remove(AGENT_CONFIG_KEYS.providerAccounts);
      else set(AGENT_CONFIG_KEYS.providerAccounts, pairs.join(','));
    },
    getReasoningEffort() {
      const effort = get(AGENT_CONFIG_KEYS.reasoningEffort);

      return isReasoningEffort(effort) ? effort : null;
    },
    setReasoningEffort(effort) {
      if (effort === null) return remove(AGENT_CONFIG_KEYS.reasoningEffort);

      return settleSync(setValid(AGENT_CONFIG_KEYS.reasoningEffort, effort, isReasoningEffort(effort), 'reasoning effort'));
    },
    getCacheRetention() {
      const value = get(AGENT_CONFIG_KEYS.cacheRetention);

      return isCacheRetention(value) ? value : DEFAULT_CACHE_RETENTION;
    },
    setCacheRetention(retention) {
      return settleSync(setValid(AGENT_CONFIG_KEYS.cacheRetention, retention, isCacheRetention(retention), 'cache retention'));
    },
    getDisplayName() { return get(AGENT_CONFIG_KEYS.displayName); },
    setDisplayName(name) { set(AGENT_CONFIG_KEYS.displayName, name); },
    getNameOrigin() {
      const stored = get(AGENT_CONFIG_KEYS.nameOrigin);

      return stored === null ? null : nameOriginOf(stored);
    },
    setNameOrigin(origin) { set(AGENT_CONFIG_KEYS.nameOrigin, origin); },
    setDisplayNameOrigin(name, origin) {
      authorize();
      reads().changed(actorId);
      void sql`
        INSERT INTO actor_config (actor_id, key, value) VALUES
          (${actorId}, ${AGENT_CONFIG_KEYS.displayName}, ${name}),
          (${actorId}, ${AGENT_CONFIG_KEYS.nameOrigin}, ${origin})
        ON CONFLICT(actor_id, key) DO UPDATE SET value = excluded.value
      `;
    },
    getRoleSelection: readRoleSelection,
    setRoleSelection(roleId) {
      set(AGENT_CONFIG_KEYS.roleSelection, roleId);
    },
    getAssignedTier(): TierId | null {
      const stored = get(AGENT_CONFIG_KEYS.assignedTier);

      // An unknown tier reads as unpinned so the role's tier still runs.
      return stored !== null && isTierId(stored) ? stored : null;
    },
    setAssignedTier(tier) {
      if (tier === null) return remove(AGENT_CONFIG_KEYS.assignedTier);

      return settleSync(setValid(AGENT_CONFIG_KEYS.assignedTier, tier, isTierId(tier), 'assigned tier'));
    },
    getRoleChangePolicy(): 'allow' | 'approval' | 'locked' {
      return parseRoleChangePolicy(get(AGENT_CONFIG_KEYS.roleChangePolicy));
    },
    setRoleChangePolicy(policy) {
      const valid = policy === 'allow' || policy === 'approval' || policy === 'locked';

      return settleSync(setValid(AGENT_CONFIG_KEYS.roleChangePolicy, policy, valid, 'role change policy'));
    },
    getShellApprovalMode(): ShellApprovalMode {
      const stored = get(AGENT_CONFIG_KEYS.shellApprovalMode);

      return stored === 'allow_all' || stored === 'deny_all' ? stored : 'strict';
    },
    setShellApprovalMode(mode) {
      const valid = mode === 'strict' || mode === 'allow_all' || mode === 'deny_all';

      return settleSync(setValid(AGENT_CONFIG_KEYS.shellApprovalMode, mode, valid, 'shell approval mode'));
    },
    getShellApprovalGrants: storedGrants,
    grantShellApproval(grants) { writeGrants([...storedGrants(), ...grants]); },
    revokeShellApproval(grants) {
      const dropped = new Set(grants.map(formatApprovalGrant));
      writeGrants(storedGrants().filter((g) => !dropped.has(formatApprovalGrant(g))));
    },
    // Autonomy switches default on; only an explicit 'false' opts out.
    getSleepTimeComputeEnabled() {
      return get(AGENT_CONFIG_KEYS.sleepTimeCompute) !== 'false';
    },
    setSleepTimeComputeEnabled(enabled) {
      set(AGENT_CONFIG_KEYS.sleepTimeCompute, enabled ? 'true' : 'false');
    },
    getLiveTrials() { return get(AGENT_CONFIG_KEYS.liveTrials) === 'true'; },
    setLiveTrials(enabled) { set(AGENT_CONFIG_KEYS.liveTrials, String(enabled)); },
    getHoldsPlans() { return get(AGENT_CONFIG_KEYS.holdsPlans) === 'true'; },
    setHoldsPlans() { set(AGENT_CONFIG_KEYS.holdsPlans, 'true'); },
    getHoldsTurns() { return get(AGENT_CONFIG_KEYS.holdsTurns) === 'true'; },
    setHoldsTurns() { set(AGENT_CONFIG_KEYS.holdsTurns, 'true'); },
    getHoldsQuestions() { return get(AGENT_CONFIG_KEYS.holdsQuestions) === 'true'; },
    setHoldsQuestions() { set(AGENT_CONFIG_KEYS.holdsQuestions, 'true'); },
    getLearning() { return get(AGENT_CONFIG_KEYS.learning) !== 'false'; },
    setLearning(enabled) { set(AGENT_CONFIG_KEYS.learning, String(enabled)); },
    getAdvisorEnabled() { return get(AGENT_CONFIG_KEYS.advisorEnabled) === 'true'; },
    setAdvisorEnabled(enabled) { set(AGENT_CONFIG_KEYS.advisorEnabled, String(enabled)); },
    getAdvisorMinSeverity() {
      const stored = get(AGENT_CONFIG_KEYS.advisorMinSeverity);

      return isAdvisorSeverity(stored) ? stored : DEFAULT_ADVISOR_MIN_SEVERITY;
    },
    setAdvisorMinSeverity(severity) {
      return settleSync(setValid(AGENT_CONFIG_KEYS.advisorMinSeverity, severity, isAdvisorSeverity(severity), 'advisor severity'));
    },
    getAlwaysActiveSkills() {
      const stored = get(AGENT_CONFIG_KEYS.alwaysActiveSkills);

      if (!stored) return [];

      return stored.split(',').map(s => s.trim()).filter(Boolean);
    },
    setAlwaysActiveSkills(names) {
      const joined = Array.from(new Set(names.map(n => n.trim()).filter(Boolean))).join(',');

      if (joined.length === 0) remove(AGENT_CONFIG_KEYS.alwaysActiveSkills);
      else set(AGENT_CONFIG_KEYS.alwaysActiveSkills, joined);
    },
    getLastActiveExecutor() { return get(AGENT_CONFIG_KEYS.lastActiveExecutor); },
    setLastActiveExecutor(name) {
      // Shape check only: executors register dynamically.
      if (/^[a-z0-9_-]{1,32}$/i.test(name)) set(AGENT_CONFIG_KEYS.lastActiveExecutor, name);
    },
    getChangelogSeenAt() {
      const n = Number(get(AGENT_CONFIG_KEYS.changelogSeenAt));

      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    setChangelogSeenAt(ms) {
      if (Number.isFinite(ms) && ms > 0) set(AGENT_CONFIG_KEYS.changelogSeenAt, String(Math.floor(ms)));
    },
    countClosedTurnWindow() {
      return increment(AGENT_CONFIG_KEYS.closedTurnWindows);
    },
    countIsolateGeneration() {
      return increment(AGENT_CONFIG_KEYS.isolateGen);
    },
    getEmailNotificationsEnabled() {
      return get(AGENT_CONFIG_KEYS.emailNotifications) !== 'false';
    },
    setEmailNotificationsEnabled(enabled) {
      set(AGENT_CONFIG_KEYS.emailNotifications, enabled ? 'true' : 'false');
    },
    getChatTitle() {
      return get(AGENT_CONFIG_KEYS.chatTitle);
    },
    setChatTitle(title) {
      set(AGENT_CONFIG_KEYS.chatTitle, title);
    },
  };
}
