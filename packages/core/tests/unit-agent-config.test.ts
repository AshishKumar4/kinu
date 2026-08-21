import { describe, test, expect } from 'bun:test';
import {
  createAgentConfigStore, initAgentConfigTable, AGENT_CONFIG_KEYS,
  DEFAULT_AUTO_GEPA_EVERY_N_TURNS, DEFAULT_GEPA_EVAL_BUDGET,
  setReasoningEffort,
} from '../src/index';
import { createTestSql } from '@kinu.run/test-utils';

function setup() {
  const { sql, execRaw } = createTestSql();
  initAgentConfigTable(execRaw);
  return createAgentConfigStore(sql);
}

describe('AgentConfigStore — generic get/set/delete', () => {
  test('round-trip + null on missing', () => {
    const c = setup();
    expect(c.get('missing')).toBeNull();
    c.set('x', 'one');
    expect(c.get('x')).toBe('one');
    c.set('x', 'two');
    expect(c.get('x')).toBe('two');
    c.delete('x');
    expect(c.get('x')).toBeNull();
  });

  test('all() returns every row as a plain object', () => {
    const c = setup();
    c.set('a', '1'); c.set('b', '2');
    expect(c.all()).toEqual({ a: '1', b: '2' });
  });
});

describe('AgentConfigStore — lastActiveExecutor', () => {
  test('round-trips a valid executor name', () => {
    const c = setup();
    expect(c.getLastActiveExecutor()).toBeNull();
    c.setLastActiveExecutor('sandbox');
    expect(c.getLastActiveExecutor()).toBe('sandbox');
    c.setLastActiveExecutor('workspace');
    expect(c.getLastActiveExecutor()).toBe('workspace');
  });

  test('rejects values that are not plausible executor namespaces', () => {
    const c = setup();
    c.setLastActiveExecutor('sandbox');
    c.setLastActiveExecutor('; DROP TABLE agent_config; --');
    c.setLastActiveExecutor('');
    c.setLastActiveExecutor('a'.repeat(40));
    expect(c.getLastActiveExecutor()).toBe('sandbox'); // unchanged by the bad writes
  });
});

describe('AgentConfigStore — auto-GEPA cadence', () => {
  test('unset defaults to the autonomous cadence; explicit values stick', () => {
    const c = setup();
    expect(c.getAutoGepaEveryNTurns()).toBe(DEFAULT_AUTO_GEPA_EVERY_N_TURNS); // default ON
    c.setAutoGepaEveryNTurns(40);
    expect(c.getAutoGepaEveryNTurns()).toBe(40);
  });

  test('explicit disable (0/negative) persists and beats the default', () => {
    const c = setup();
    c.setAutoGepaEveryNTurns(0);
    expect(c.getAutoGepaEveryNTurns()).toBe(0); // stored '0', not unset
    expect(c.get(AGENT_CONFIG_KEYS.autoGepaEveryNTurns)).toBe('0');
    c.setAutoGepaEveryNTurns(20);
    c.setAutoGepaEveryNTurns(-5); // disables
    expect(c.getAutoGepaEveryNTurns()).toBe(0);
  });

  test('an agent that explicitly configured a cadence keeps it', () => {
    const c = setup();
    c.set(AGENT_CONFIG_KEYS.autoGepaEveryNTurns, '7'); // pre-flip explicit config
    expect(c.getAutoGepaEveryNTurns()).toBe(7);
  });
});

describe('AgentConfigStore — typed accessors', () => {
  test('model: get/set round-trip + canonical key', () => {
    const c = setup();
    expect(c.getModel()).toBeNull();
    c.setModel('codex/gpt-5.5');
    expect(c.getModel()).toBe('codex/gpt-5.5');
    // Confirm it writes to the canonical key (other readers depend on it).
    expect(c.get(AGENT_CONFIG_KEYS.model)).toBe('codex/gpt-5.5');
  });

  test('reasoning effort: validates and round-trips the canonical key', () => {
    const c = setup();
    expect(c.getReasoningEffort()).toBeNull();
    c.setReasoningEffort('high');
    expect(c.getReasoningEffort()).toBe('high');
    expect(c.get(AGENT_CONFIG_KEYS.reasoningEffort)).toBe('high');

    c.set(AGENT_CONFIG_KEYS.reasoningEffort, 'extreme');
    expect(c.getReasoningEffort()).toBeNull();
    expect(() => setReasoningEffort(c, 'extreme'))
      .toThrow('Invalid reasoning effort');
  });

  test('cache retention: round-trips, and anything unusable reads as the short default', () => {
    const c = setup();
    expect(c.getCacheRetention()).toBe('short');
    c.setCacheRetention('long');
    expect(c.getCacheRetention()).toBe('long');
    expect(c.get(AGENT_CONFIG_KEYS.cacheRetention)).toBe('long');
    c.setCacheRetention('none');
    expect(c.getCacheRetention()).toBe('none');

    // A garbage row must never leave the caching seam without an answer.
    c.set(AGENT_CONFIG_KEYS.cacheRetention, 'forever');
    expect(c.getCacheRetention()).toBe('short');
  });

  test('displayName: default null', () => {
    const c = setup();
    expect(c.getDisplayName()).toBeNull();
    c.setDisplayName('my agent');
    expect(c.getDisplayName()).toBe('my agent');
  });

  test('shellApprovalMode: defaults to strict, validates input', () => {
    const c = setup();
    expect(c.getShellApprovalMode()).toBe('strict');
    c.setShellApprovalMode('allow_all');
    expect(c.getShellApprovalMode()).toBe('allow_all');
    c.setShellApprovalMode('deny_all');
    expect(c.getShellApprovalMode()).toBe('deny_all');
    // Garbage in DB → strict fallback.
    c.set(AGENT_CONFIG_KEYS.shellApprovalMode, 'bogus');
    expect(c.getShellApprovalMode()).toBe('strict');
  });

  test('shellApprovalGrants: empty by default, dedupes, revokes, survives garbage', () => {
    const c = setup();
    expect(c.getShellApprovalGrants()).toEqual([]);

    c.grantShellApproval([{ rule: 'rm-recursive', executor: 'laptop' }]);
    // Granting the same thing twice is one grant, not two.
    c.grantShellApproval([
      { rule: 'rm-recursive', executor: 'laptop' },
      { rule: 'sudo', executor: 'parent' },
    ]);
    expect(c.getShellApprovalGrants()).toEqual([
      { rule: 'rm-recursive', executor: 'laptop' },
      { rule: 'sudo', executor: 'parent' },
    ]);

    // Revoking one leaves the other; revoking something never granted is fine.
    c.revokeShellApproval([
      { rule: 'rm-recursive', executor: 'laptop' },
      { rule: 'nothing', executor: 'nowhere' },
    ]);
    expect(c.getShellApprovalGrants()).toEqual([{ rule: 'sudo', executor: 'parent' }]);

    // A value that cannot be parsed must never widen what runs.
    c.set(AGENT_CONFIG_KEYS.shellApprovalGrants, 'bogus,@,rule@,,sudo@laptop');
    expect(c.getShellApprovalGrants()).toEqual([{ rule: 'sudo', executor: 'laptop' }]);

    c.revokeShellApproval([{ rule: 'sudo', executor: 'laptop' }]);
    expect(c.getShellApprovalGrants()).toEqual([]);
    expect(c.get(AGENT_CONFIG_KEYS.shellApprovalGrants)).toBeNull();
  });

  test('sleepTimeCompute: defaults ON; explicit false sticks', () => {
    const c = setup();
    expect(c.getSleepTimeComputeEnabled()).toBe(true); // autonomy default ON
    c.setSleepTimeComputeEnabled(false);
    expect(c.getSleepTimeComputeEnabled()).toBe(false); // explicit opt-out wins
    c.setSleepTimeComputeEnabled(true);
    expect(c.getSleepTimeComputeEnabled()).toBe(true);
  });

  test('autoPromoteScaffold: defaults ON; explicit false sticks', () => {
    const c = setup();
    expect(c.getAutoPromoteScaffold()).toBe(true); // autonomy default ON
    c.set(AGENT_CONFIG_KEYS.autoPromoteScaffold, 'false');
    expect(c.getAutoPromoteScaffold()).toBe(false); // explicit opt-out wins
    c.set(AGENT_CONFIG_KEYS.autoPromoteScaffold, 'true');
    expect(c.getAutoPromoteScaffold()).toBe(true);
  });

  test('changelogSeenAt: 0 until marked, then sticks', () => {
    const c = setup();
    expect(c.getChangelogSeenAt()).toBe(0);
    c.setChangelogSeenAt(1_750_000_000_000);
    expect(c.getChangelogSeenAt()).toBe(1_750_000_000_000);
    c.setChangelogSeenAt(Number.NaN); // ignored
    expect(c.getChangelogSeenAt()).toBe(1_750_000_000_000);
  });

  test('shadowSampleRate: defaults 0.25, parses + clamps', () => {
    const c = setup();
    expect(c.getShadowSampleRate()).toBe(0.25);
    c.set(AGENT_CONFIG_KEYS.shadowSampleRate, '0.5');
    expect(c.getShadowSampleRate()).toBe(0.5);
    // Out-of-range / NaN → default.
    c.set(AGENT_CONFIG_KEYS.shadowSampleRate, '2.0');
    expect(c.getShadowSampleRate()).toBe(0.25);
    c.set(AGENT_CONFIG_KEYS.shadowSampleRate, 'not-a-number');
    expect(c.getShadowSampleRate()).toBe(0.25);
  });

  test('the evolution knobs round-trip through their setters and reject bad input', () => {
    const c = setup();

    c.setAutoPromoteScaffold(false);
    expect(c.getAutoPromoteScaffold()).toBe(false);
    c.setAutoPromoteScaffold(true);
    expect(c.getAutoPromoteScaffold()).toBe(true);

    c.setShadowSampleRate(0.5);
    expect(c.getShadowSampleRate()).toBe(0.5);
    c.setScaffoldExploreShare(0);
    expect(c.getScaffoldExploreShare()).toBe(0);

    // A probability given as a percentage is a caller bug, not something to
    // silently clamp to 1 — otherwise every turn would run in shadow.
    expect(() => c.setShadowSampleRate(100)).toThrow(/invalid shadow_sample_rate/);
    expect(() => c.setScaffoldExploreShare(-0.1)).toThrow(/invalid scaffold_explore_share/);
    expect(() => c.setShadowSampleRate(Number.NaN)).toThrow(/invalid shadow_sample_rate/);
    expect(c.getShadowSampleRate()).toBe(0.5);

    c.setRoleModel('judge', 'anthropic/claude-opus-4-7');
    expect(c.getRoleModel('judge')).toBe('anthropic/claude-opus-4-7');
    c.setRoleModel('judge', '  openai/gpt-5  ');
    expect(c.getRoleModel('judge')).toBe('openai/gpt-5');
    c.setRoleModel('judge', null);
    expect(c.getRoleModel('judge')).toBeNull();   // cleared → cross-family auto-pick
    c.setRoleModel('judge', '   ');
    expect(c.getRoleModel('judge')).toBeNull();

    // The budget's bounds are a cost policy, so a setter clamps rather than throws.
    c.setGepaEvalBudget(1000);
    expect(c.getGepaEvalBudget()).toBe(64);
    c.setGepaEvalBudget(1);
    expect(c.getGepaEvalBudget()).toBe(4);
  });
});

describe('AgentConfigStore — MCTS overrides', () => {
  test('empty when nothing stored (engine defaults apply at call sites)', () => {
    const c = setup();
    expect(c.getMctsOverrides()).toEqual({});
  });

  test('round-trips only the explicitly set knobs', () => {
    const c = setup();
    c.setMctsOverrides({ explorationWeight: 1.2, branches: 4 });
    expect(c.getMctsOverrides()).toEqual({ explorationWeight: 1.2, branches: 4 });
    c.setMctsOverrides({ budget: 8, maxDepth: 6 });
    expect(c.getMctsOverrides()).toEqual({ explorationWeight: 1.2, budget: 8, maxDepth: 6, branches: 4 });
  });

  test('floors integer knobs and rejects non-positive values', () => {
    const c = setup();
    c.setMctsOverrides({ budget: 3.7 });
    expect(c.getMctsOverrides()).toEqual({ budget: 3 });
    expect(() => c.setMctsOverrides({ branches: 0 })).toThrow(/invalid MCTS setting/);
    expect(() => c.setMctsOverrides({ explorationWeight: Number.NaN })).toThrow(/invalid MCTS setting/);
  });

  test('garbage stored values are ignored on read', () => {
    const c = setup();
    c.set(AGENT_CONFIG_KEYS.mctsBudget, 'lots');
    c.set(AGENT_CONFIG_KEYS.mctsBranches, '-2');
    expect(c.getMctsOverrides()).toEqual({});
  });
});

describe('AgentConfigStore — GEPA eval budget', () => {
  test('defaults to 24, reads stored values, clamps to 4..64, ignores garbage', () => {
    const c = setup();
    expect(c.getGepaEvalBudget()).toBe(DEFAULT_GEPA_EVAL_BUDGET);
    c.set(AGENT_CONFIG_KEYS.gepaEvalBudget, '12');
    expect(c.getGepaEvalBudget()).toBe(12);
    c.set(AGENT_CONFIG_KEYS.gepaEvalBudget, '500');
    expect(c.getGepaEvalBudget()).toBe(64);
    // Below the floor a disjoint split is impossible — clamp up, don't accept.
    c.set(AGENT_CONFIG_KEYS.gepaEvalBudget, '1');
    expect(c.getGepaEvalBudget()).toBe(4);
    c.set(AGENT_CONFIG_KEYS.gepaEvalBudget, 'many');
    expect(c.getGepaEvalBudget()).toBe(DEFAULT_GEPA_EVAL_BUDGET);
  });
});

/**
 * Every config key must be writable by something.
 *
 * Three keys have shipped read-only so far — a getter consulted at runtime with
 * no setter, no RPC and no command anywhere, so the behaviour it gated could
 * never actually be turned on. This guard makes that state unshippable: adding a
 * key to AGENT_CONFIG_KEYS forces you to name the store method that writes it,
 * and a key nothing writes fails here rather than years later.
 *
 * Runtime, not source-scanning: each writer is really invoked against a real
 * store and the keys it touches are read back out of the table, so the guard
 * cannot drift from how the store is actually implemented.
 */
describe('AgentConfigStore — every key has a write path', () => {
  /** One call per store method that writes config. Values are arbitrary but
   *  valid; only which KEYS get written matters. */
  const WRITERS: ReadonlyArray<(c: ReturnType<typeof setup>) => void> = [
    (c) => c.setModel('openai/gpt-5'),
    (c) => c.setReasoningEffort('high'),
    (c) => c.setCacheRetention('long'),
    (c) => c.setDisplayName('Ada'),
    (c) => c.setNameOrigin('user'),
    (c) => c.setStance('audit'),
    (c) => c.setShellApprovalMode('allow_all'),
    (c) => c.grantShellApproval([{ rule: 'rm-recursive', executor: 'laptop' }]),
    (c) => c.setSleepTimeComputeEnabled(false),
    (c) => c.setAutoPromoteScaffold(false),
    (c) => c.setShadowSampleRate(0.5),
    (c) => c.setScaffoldExploreShare(0.3),
    (c) => c.setRoleModel('judge', 'anthropic/claude-opus-4-7'),
    (c) => c.setRoleModel('fast', 'anthropic/claude-haiku-4-5'),
    (c) => c.setRoleModel('advisor', 'openai/gpt-5-mini'),
    (c) => c.setAdvisorEnabled(true),
    (c) => c.setAdvisorMinSeverity('blocker'),
    (c) => c.setAlwaysActiveSkills(['research']),
    (c) => c.setLastActiveExecutor('sandbox'),
    (c) => c.setAutoGepaEveryNTurns(10),
    (c) => c.setChangelogSeenAt(1_750_000_000_000),
    (c) => c.countClosedSessionWindow(),
    (c) => c.countIsolateGeneration(),
    (c) => c.setGepaEvalBudget(16),
    (c) => c.setMctsOverrides({
      explorationWeight: 1.2, budget: 8, maxDepth: 4,
      branches: 3, judgeSamples: 2, maxEvalLLMCalls: 5,
    }),
    (c) => c.setEmailNotificationsEnabled(false),
  ];

  /** Internal plumbing written through the generic `set` from outside the
   *  store (memory-sync's lazy Vectorize backfill). Exempt because the write
   *  path is real, just not a typed method here. */
  const GENERIC_WRITE_PATH: ReadonlyArray<string> = [
    AGENT_CONFIG_KEYS.memoryVectorBackfillDone,
    AGENT_CONFIG_KEYS.memoryVectorBackfillCursor,
  ];

  test('no key is readable-but-unwritable', () => {
    const c = setup();
    for (const write of WRITERS) write(c);
    const written = new Set([...Object.keys(c.all()), ...GENERIC_WRITE_PATH]);

    const unwritable = Object.values(AGENT_CONFIG_KEYS).filter((k) => !written.has(k));
    expect(unwritable).toEqual([]);
  });

  test('the guard actually catches an unwritten key', () => {
    // Proves the assertion above is load-bearing: drop one writer and the key
    // it owns shows up as unwritable.
    const c = setup();
    for (const write of WRITERS.slice(1)) write(c);
    const written = new Set([...Object.keys(c.all()), ...GENERIC_WRITE_PATH]);
    expect(Object.values(AGENT_CONFIG_KEYS).filter((k) => !written.has(k)))
      .toEqual([AGENT_CONFIG_KEYS.model]);
  });
});
