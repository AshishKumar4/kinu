// AgentConfigStore: typed accessors over the `actor_config` key/value table.
import type { SqlExecutor, RawSqlExec } from '../types/primitives';
import { nameOriginOf, type NameOrigin } from '../identity/naming';
import { isAccountName, isProviderScope } from '../credentials/accounts';
import { isReasoningEffort, type ReasoningEffort } from '../providers/reasoning-effort';
import { DEFAULT_ROLE_ID, isTierId, isValidRoleId, type RoleId, type TierId } from '../types/profile';
import {
  DEFAULT_CACHE_RETENTION, isCacheRetention, type CacheRetention,
} from '../providers/types';
import {
  formatApprovalGrant, parseApprovalGrant, type ApprovalGrant,
} from '../safety/approval-gate';
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
  autoPromoteScaffold: 'auto_promote_scaffold',
  shadowSampleRate: 'shadow_sample_rate',
  /** Share of scaffold proposals branching from an archived variant (DGM archive exploration). */
  scaffoldExploreShare: 'scaffold_explore_share',
  advisorMinSeverity: 'advisor_min_severity',
  /** 'true' enables the turn reviewer; off by default since it costs a model call per turn. */
  advisorEnabled: 'advisor_enabled',
  alwaysActiveSkills: 'always_active_skills',
  /** Executor namespace of the last tool run; UI defaults to it. */
  lastActiveExecutor: 'last_active_executor',
  /** Auto-GEPA cadence in turns of new traces (0 = off; unset = default). */
  autoGepaEveryNTurns: 'auto_gepa_every_n_turns',
  /** Epoch ms of the last Evolution Changelog view; newer entries drive the unseen badge. */
  changelogSeenAt: 'changelog_seen_at',
  closedTurnWindows: 'closed_turn_windows',
  /** See DEFAULT_GEPA_EVAL_BUDGET. */
  gepaEvalBudget: 'gepa_eval_budget',
  /** Unset = engine defaults (DEFAULT_CONFIG.mcts). */
  mctsExplorationWeight: 'mcts_c',
  mctsBudget: 'mcts_iterations',
  mctsMaxDepth: 'mcts_depth',
  mctsBranches: 'mcts_branches',
  mctsJudgeSamples: 'mcts_judge_samples',
  mctsMaxEvalLLMCalls: 'mcts_eval_llm_calls',
  /** 'false' silences owner emails; defaults on. */
  emailNotifications: 'email_notifications',
  /** Lazy Vectorize backfill of chunks indexed before embeddings existed; cursor pages across boots. */
  memoryVectorBackfillDone: 'memory_vector_backfill_done',
  memoryVectorBackfillCursor: 'memory_vector_backfill_cursor',
  /** Persisted because a boot counter misses reconstructions that reuse the isolate (e.g. `ctx.facets.abort()`). */
  isolateGen: 'isolate_gen',
  /** Canonical conversation id (config/conversation.ts); absent on first open, adopted as `default`. */
  conversationId: 'conversation.id',
} as const;

/** Keys the shell-approval gate reads as authorization; a fork must not inherit them. Add any new gate key here. */
export const SHELL_APPROVAL_AUTHORITY_KEYS: readonly string[] = [
  AGENT_CONFIG_KEYS.shellApprovalMode,
  AGENT_CONFIG_KEYS.shellApprovalGrants,
];

export interface AgentConfigStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
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
  getAutoPromoteScaffold(): boolean;
  setAutoPromoteScaffold(enabled: boolean): void;
  /** Fraction of turns shadow-run through the candidate scaffold (default 0.25). */
  getShadowSampleRate(): number;
  setShadowSampleRate(rate: number): void;
  /** Default 0.2. */
  getScaffoldExploreShare(): number;
  setScaffoldExploreShare(share: number): void;
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
  /** 0 = disabled; unset defaults to DEFAULT_AUTO_GEPA_EVERY_N_TURNS. */
  getAutoGepaEveryNTurns(): number;
  /** 0 or negative explicitly disables. */
  setAutoGepaEveryNTurns(n: number): void;
  /** 0 = never seen. */
  getChangelogSeenAt(): number;
  setChangelogSeenAt(ms: number): void;
  countClosedTurnWindow(): number;
  /** Called once per activation; a gap between spans on one `selfPath` is a positive reset signal. */
  countIsolateGeneration(): number;
  getGepaEvalBudget(): number;
  /** Clamped, not rejected: the bounds are cost policy. */
  setGepaEvalBudget(n: number): void;
  /** Only explicitly set, valid knobs, so unset ones keep engine defaults. */
  getMctsOverrides(): MctsOverrides;
  /** Undefined fields are left untouched. */
  setMctsOverrides(overrides: MctsOverrides): void;
  getEmailNotificationsEnabled(): boolean;
  setEmailNotificationsEnabled(enabled: boolean): void;
}

export interface MctsOverrides {
  explorationWeight?: number;
  budget?: number;
  maxDepth?: number;
  branches?: number;
  /** Median-aggregated. */
  judgeSamples?: number;
  maxEvalLLMCalls?: number;
}

/** Default auto-GEPA cadence: one pass per this many turns of new traces. */
export const DEFAULT_AUTO_GEPA_EVERY_N_TURNS = 25;

/** Instances per GEPA pass (train + val); the dominant cost knob. CI half-width falls as 1/√n while cost is linear. */
export const DEFAULT_GEPA_EVAL_BUDGET = 24;

/** Floor keeps a disjoint split possible (2 failures + 2 guards). */
export function clampGepaEvalBudget(n: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 4), 64) : DEFAULT_GEPA_EVAL_BUDGET;
}

/** Rejects rather than clamps: an out-of-range probability is a caller bug. */
function unitInterval(key: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid ${key}: ${value} (expected a fraction between 0 and 1)`);
  }

  return value;
}

export function initAgentConfigTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS actor_config (
    actor_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (actor_id, key)
  )`);
}

export function createAgentConfigStore(sql: SqlExecutor, actorId: string, authorize: () => void): AgentConfigStore {
  const get = (key: string): string | null => {
    authorize();

    const rows = sql<{ value: string }>`
      SELECT value FROM actor_config WHERE actor_id = ${actorId} AND key = ${key} LIMIT 1`;

    return rows[0]?.value ?? null;
  };

  const set = (key: string, value: string): void => {
    authorize();
    void sql`INSERT INTO actor_config (actor_id, key, value) VALUES (${actorId}, ${key}, ${value})
        ON CONFLICT(actor_id, key) DO UPDATE SET value = excluded.value`;
  };

  const remove = (key: string): void => {
    authorize();
    void sql`DELETE FROM actor_config WHERE actor_id = ${actorId} AND key = ${key}`;
  };

  /** The read writes nothing, so an unread row stays distinguishable from a stored `task`. */
  const readRoleSelection = (): RoleId => {
    const stored = get(AGENT_CONFIG_KEYS.roleSelection);

    return stored !== null && isValidRoleId(stored) ? stored : DEFAULT_ROLE_ID;
  };

  /** Single upsert-RETURNING so two stores cannot mint the same value; unparseable rows count as 0. */
  const increment = (key: string): number => {
    authorize();

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
      const rows = sql<{ key: string; value: string }>`SELECT key, value FROM actor_config WHERE actor_id = ${actorId}`;
      const out: Record<string, string> = {};

      for (const r of rows) out[r.key] = r.value;

      return out;
    },
    getModel() { return get(AGENT_CONFIG_KEYS.model); },
    setModel(spec) { set(AGENT_CONFIG_KEYS.model, spec); },
    getProviderAccounts: storedProviderAccounts,
    setProviderAccount(provider, account) {
      if (!isProviderScope(provider)) throw new Error(`Invalid provider id: ${provider}`);

      if (account !== null && !isAccountName(account)) throw new Error(`Invalid account name: ${account}`);
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
      if (effort === null) {
        remove(AGENT_CONFIG_KEYS.reasoningEffort);

        return;
      }

      if (!isReasoningEffort(effort)) throw new Error(`Invalid reasoning effort: ${String(effort)}`);
      set(AGENT_CONFIG_KEYS.reasoningEffort, effort);
    },
    getCacheRetention() {
      const value = get(AGENT_CONFIG_KEYS.cacheRetention);

      return isCacheRetention(value) ? value : DEFAULT_CACHE_RETENTION;
    },
    setCacheRetention(retention) {
      if (!isCacheRetention(retention)) throw new Error(`Invalid cache retention: ${String(retention)}`);
      set(AGENT_CONFIG_KEYS.cacheRetention, retention);
    },
    getDisplayName() { return get(AGENT_CONFIG_KEYS.displayName); },
    setDisplayName(name) { set(AGENT_CONFIG_KEYS.displayName, name); },
    getNameOrigin() {
      const v = get(AGENT_CONFIG_KEYS.nameOrigin);

      return v === null ? null : nameOriginOf(v);
    },
    setNameOrigin(origin) { set(AGENT_CONFIG_KEYS.nameOrigin, origin); },
    setDisplayNameOrigin(name, origin) {
      authorize();
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
      if (tier === null) {
        remove(AGENT_CONFIG_KEYS.assignedTier);

        return;
      }

      if (!isTierId(tier)) throw new Error(`Invalid assigned tier: ${String(tier)}`);
      set(AGENT_CONFIG_KEYS.assignedTier, tier);
    },
    getRoleChangePolicy(): 'allow' | 'approval' | 'locked' {
      return parseRoleChangePolicy(get(AGENT_CONFIG_KEYS.roleChangePolicy));
    },
    setRoleChangePolicy(policy) {
      if (policy !== 'allow' && policy !== 'approval' && policy !== 'locked') {
        throw new Error(`Invalid role change policy: ${String(policy)}`);
      }

      set(AGENT_CONFIG_KEYS.roleChangePolicy, policy);
    },
    getShellApprovalMode(): ShellApprovalMode {
      const v = get(AGENT_CONFIG_KEYS.shellApprovalMode);

      return v === 'allow_all' || v === 'deny_all' ? v : 'strict';
    },
    setShellApprovalMode(mode) {
      if (mode !== 'strict' && mode !== 'allow_all' && mode !== 'deny_all') {
        throw new Error(`Invalid shell approval mode: ${String(mode)}`);
      }

      set(AGENT_CONFIG_KEYS.shellApprovalMode, mode);
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
    getAutoPromoteScaffold() {
      return get(AGENT_CONFIG_KEYS.autoPromoteScaffold) !== 'false';
    },
    setAutoPromoteScaffold(enabled) {
      set(AGENT_CONFIG_KEYS.autoPromoteScaffold, enabled ? 'true' : 'false');
    },
    getShadowSampleRate() {
      const v = get(AGENT_CONFIG_KEYS.shadowSampleRate);
      const n = v ? Number(v) : 0.25;

      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.25;
    },
    setShadowSampleRate(rate) { set(AGENT_CONFIG_KEYS.shadowSampleRate, String(unitInterval('shadow_sample_rate', rate))); },
    getScaffoldExploreShare() {
      const v = get(AGENT_CONFIG_KEYS.scaffoldExploreShare);
      const n = v ? Number(v) : 0.2;

      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.2;
    },
    setScaffoldExploreShare(share) { set(AGENT_CONFIG_KEYS.scaffoldExploreShare, String(unitInterval('scaffold_explore_share', share))); },
    getAdvisorEnabled() { return get(AGENT_CONFIG_KEYS.advisorEnabled) === 'true'; },
    setAdvisorEnabled(enabled) { set(AGENT_CONFIG_KEYS.advisorEnabled, String(enabled)); },
    getAdvisorMinSeverity() {
      const stored = get(AGENT_CONFIG_KEYS.advisorMinSeverity);

      return isAdvisorSeverity(stored) ? stored : DEFAULT_ADVISOR_MIN_SEVERITY;
    },
    setAdvisorMinSeverity(severity) {
      if (!isAdvisorSeverity(severity)) throw new Error(`Invalid advisor severity: ${String(severity)}`);
      set(AGENT_CONFIG_KEYS.advisorMinSeverity, severity);
    },
    getAlwaysActiveSkills() {
      const v = get(AGENT_CONFIG_KEYS.alwaysActiveSkills);

      if (!v) return [];

      return v.split(',').map(s => s.trim()).filter(Boolean);
    },
    setAlwaysActiveSkills(names) {
      const v = Array.from(new Set(names.map(n => n.trim()).filter(Boolean))).join(',');

      if (v.length === 0) remove(AGENT_CONFIG_KEYS.alwaysActiveSkills);
      else set(AGENT_CONFIG_KEYS.alwaysActiveSkills, v);
    },
    getLastActiveExecutor() { return get(AGENT_CONFIG_KEYS.lastActiveExecutor); },
    setLastActiveExecutor(name) {
      // Shape check only: executors register dynamically.
      if (/^[a-z0-9_-]{1,32}$/i.test(name)) set(AGENT_CONFIG_KEYS.lastActiveExecutor, name);
    },
    getAutoGepaEveryNTurns() {
      const raw = get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns);

      if (raw == null) return DEFAULT_AUTO_GEPA_EVERY_N_TURNS;
      const n = Math.floor(Number(raw));

      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    setAutoGepaEveryNTurns(n) {
      // Persist 0 explicitly: unset means the default cadence.
      const value = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      set(AGENT_CONFIG_KEYS.autoGepaEveryNTurns, String(value));
    },
    getGepaEvalBudget() {
      const raw = get(AGENT_CONFIG_KEYS.gepaEvalBudget);

      if (raw == null) return DEFAULT_GEPA_EVAL_BUDGET;
      const n = Number(raw);

      return Number.isFinite(n) ? clampGepaEvalBudget(n) : DEFAULT_GEPA_EVAL_BUDGET;
    },
    setGepaEvalBudget(n) { set(AGENT_CONFIG_KEYS.gepaEvalBudget, String(clampGepaEvalBudget(n))); },
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
    getMctsOverrides() {
      const positive = (key: string): number | undefined => {
        const raw = get(key);

        if (raw == null) return undefined;
        const n = Number(raw);

        return Number.isFinite(n) && n > 0 ? n : undefined;
      };

      const out: MctsOverrides = {};
      const w = positive(AGENT_CONFIG_KEYS.mctsExplorationWeight);
      const budget = positive(AGENT_CONFIG_KEYS.mctsBudget);
      const maxDepth = positive(AGENT_CONFIG_KEYS.mctsMaxDepth);
      const branches = positive(AGENT_CONFIG_KEYS.mctsBranches);
      const judgeSamples = positive(AGENT_CONFIG_KEYS.mctsJudgeSamples);
      const maxEvalLLMCalls = positive(AGENT_CONFIG_KEYS.mctsMaxEvalLLMCalls);

      if (w !== undefined) out.explorationWeight = w;

      if (budget !== undefined) out.budget = Math.floor(budget);

      if (maxDepth !== undefined) out.maxDepth = Math.floor(maxDepth);

      if (branches !== undefined) out.branches = Math.floor(branches);

      if (judgeSamples !== undefined) out.judgeSamples = Math.floor(judgeSamples);

      if (maxEvalLLMCalls !== undefined) out.maxEvalLLMCalls = Math.floor(maxEvalLLMCalls);

      return out;
    },
    setMctsOverrides(overrides) {
      // Validate all before writing, so a rejected call changes nothing.
      const pending: Array<{ key: string; value: string }> = [];

      const check = (key: string, value: number | undefined, integer: boolean) => {
        if (value === undefined) return;

        if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid MCTS setting for ${key}: ${value}`);
        const stored = integer ? Math.floor(value) : value;

        if (stored <= 0) throw new Error(`invalid MCTS setting for ${key}: ${value}`);
        pending.push({ key, value: String(stored) });
      };

      check(AGENT_CONFIG_KEYS.mctsExplorationWeight, overrides.explorationWeight, false);
      check(AGENT_CONFIG_KEYS.mctsBudget, overrides.budget, true);
      check(AGENT_CONFIG_KEYS.mctsMaxDepth, overrides.maxDepth, true);
      check(AGENT_CONFIG_KEYS.mctsBranches, overrides.branches, true);
      check(AGENT_CONFIG_KEYS.mctsJudgeSamples, overrides.judgeSamples, true);
      check(AGENT_CONFIG_KEYS.mctsMaxEvalLLMCalls, overrides.maxEvalLLMCalls, true);

      for (const { key, value } of pending) set(key, value);
    },
    getEmailNotificationsEnabled() {
      return get(AGENT_CONFIG_KEYS.emailNotifications) !== 'false';
    },
    setEmailNotificationsEnabled(enabled) {
      set(AGENT_CONFIG_KEYS.emailNotifications, enabled ? 'true' : 'false');
    },
  };
}
