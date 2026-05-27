// AgentConfigStore — typed accessors over the `agent_config` key/value table.
//
// Before this, 23 raw `SELECT ... FROM agent_config` / `INSERT OR REPLACE ...`
// sites were scattered across orchestrator.ts, runtime.ts, head-runtime.ts,
// fork.ts. Adding a new tunable meant editing schema + 5 different files.
//
// The store is a deep module (small interface, real behavior): typed getters
// for known keys, generic get/set/delete for everything else, all() for fork.
import type { SqlExecutor, RawSqlExec } from '../types/primitives.js';

export type ShellApprovalMode = 'strict' | 'allow_all' | 'deny_all';

/** Known config keys. Adding one here forces a typed getter/setter — that
 *  catches typos at compile time. */
export const AGENT_CONFIG_KEYS = {
  model: 'model',
  displayName: 'display_name',
  shellApprovalMode: 'shell_approval_mode',
  sleepTimeCompute: 'sleep_time_compute',
  autoPromoteScaffold: 'auto_promote_scaffold',
  shadowSampleRate: 'shadow_sample_rate',
  toolSurfacingMode: 'tool_surfacing_mode',
  reviewModel: 'review_model',
} as const;
export type AgentConfigKey = (typeof AGENT_CONFIG_KEYS)[keyof typeof AGENT_CONFIG_KEYS];

export interface AgentConfigStore {
  // ── Generic accessors ──
  /** Read a single config value. Returns null if unset. */
  get(key: string): string | null;
  /** Write (upsert) a config value. */
  set(key: string, value: string): void;
  /** Delete a config value. No-op if absent. */
  delete(key: string): void;
  /** All config rows as a plain object. Used by fork.ts to copy state. */
  all(): Record<string, string>;

  // ── Typed accessors for known keys ──
  getModel(): string | null;
  setModel(spec: string): void;
  getDisplayName(): string | null;
  setDisplayName(name: string): void;
  getShellApprovalMode(): ShellApprovalMode;
  setShellApprovalMode(mode: ShellApprovalMode): void;
  getSleepTimeComputeEnabled(): boolean;
  setSleepTimeComputeEnabled(enabled: boolean): void;
  getAutoPromoteScaffold(): boolean;
  getShadowSampleRate(): number;
  getToolSurfacingMode(): 'all' | 'relevant';
  getReviewModel(): string | null;
}

export function initAgentConfigTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS agent_config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  )`);
}

export function createAgentConfigStore(sql: SqlExecutor): AgentConfigStore {
  const get = (key: string): string | null => {
    try {
      const rows = sql<{ value: string }>`
        SELECT value FROM agent_config WHERE key = ${key} LIMIT 1`;
      return rows[0]?.value ?? null;
    } catch { return null; }
  };
  const set = (key: string, value: string): void => {
    sql`INSERT INTO agent_config (key, value) VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  };
  return {
    get,
    set,
    delete(key) { sql`DELETE FROM agent_config WHERE key = ${key}`; },
    all() {
      try {
        const rows = sql<{ key: string; value: string }>`SELECT key, value FROM agent_config`;
        const out: Record<string, string> = {};
        for (const r of rows) out[r.key] = r.value;
        return out;
      } catch { return {}; }
    },
    getModel() { return get(AGENT_CONFIG_KEYS.model); },
    setModel(spec) { set(AGENT_CONFIG_KEYS.model, spec); },
    getDisplayName() { return get(AGENT_CONFIG_KEYS.displayName); },
    setDisplayName(name) { set(AGENT_CONFIG_KEYS.displayName, name); },
    getShellApprovalMode(): ShellApprovalMode {
      const v = get(AGENT_CONFIG_KEYS.shellApprovalMode);
      return v === 'allow_all' || v === 'deny_all' ? v : 'strict';
    },
    setShellApprovalMode(mode) { set(AGENT_CONFIG_KEYS.shellApprovalMode, mode); },
    getSleepTimeComputeEnabled() {
      return get(AGENT_CONFIG_KEYS.sleepTimeCompute) === 'true';
    },
    setSleepTimeComputeEnabled(enabled) {
      set(AGENT_CONFIG_KEYS.sleepTimeCompute, enabled ? 'true' : 'false');
    },
    getAutoPromoteScaffold() {
      return get(AGENT_CONFIG_KEYS.autoPromoteScaffold) === 'true';
    },
    getShadowSampleRate() {
      const v = get(AGENT_CONFIG_KEYS.shadowSampleRate);
      const n = v ? Number(v) : 0.25;
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.25;
    },
    getToolSurfacingMode() {
      const v = get(AGENT_CONFIG_KEYS.toolSurfacingMode);
      return v === 'relevant' ? 'relevant' : 'all';
    },
    getReviewModel() { return get(AGENT_CONFIG_KEYS.reviewModel); },
  };
}
