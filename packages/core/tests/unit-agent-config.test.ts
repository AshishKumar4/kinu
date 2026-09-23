import { describe, test, expect } from 'bun:test';
import {
  AGENT_CONFIG_KEYS,
  DEFAULT_AUTO_GEPA_EVERY_N_TURNS, DEFAULT_GEPA_EVAL_BUDGET,
  canonicalConversationId, setReasoningEffort,
} from '../src/index';
import { Database } from 'bun:sqlite';
import { createTestSql } from '@kinu.run/test-utils';
import { wrapDatabase } from '../src/identity/create';
import { createTestActor } from './helpers';

function setup() {
  const { sql, execRaw } = createTestSql();

  return createTestActor(sql, execRaw, crypto.randomUUID(), 'config-test').config;
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
    c.setLastActiveExecutor('; DROP TABLE actor_config; --');
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
    // Other readers depend on the canonical key.
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

    c.set(AGENT_CONFIG_KEYS.cacheRetention, 'forever');
    expect(c.getCacheRetention()).toBe('short');
  });

  test('displayName: default null', () => {
    const c = setup();
    expect(c.getDisplayName()).toBeNull();
    c.setDisplayName('my agent');
    expect(c.getDisplayName()).toBe('my agent');
  });

  test('displayName and origin are committed together', () => {
    const c = setup();
    c.setDisplayNameOrigin('Jarvis', 'user');
    expect(c.getDisplayName()).toBe('Jarvis');
    expect(c.getNameOrigin()).toBe('user');
  });

  test('shellApprovalMode: defaults to strict, validates input', () => {
    const c = setup();
    expect(c.getShellApprovalMode()).toBe('strict');
    c.setShellApprovalMode('allow_all');
    expect(c.getShellApprovalMode()).toBe('allow_all');
    c.setShellApprovalMode('deny_all');
    expect(c.getShellApprovalMode()).toBe('deny_all');
    c.set(AGENT_CONFIG_KEYS.shellApprovalMode, 'bogus');
    expect(c.getShellApprovalMode()).toBe('strict');
  });

  test('role policy, shell mode and severity setters refuse what their getters would hide', () => {
    const c = setup();
    // Decoded, not written: runtime garbage arrives past the type boundary.
    const bogus = JSON.parse('"bogus"');
    c.setRoleChangePolicy('approval');
    expect(() => c.setRoleChangePolicy(bogus)).toThrow(/Invalid role change policy/);
    expect(c.getRoleChangePolicy()).toBe('approval');
    expect(c.get(AGENT_CONFIG_KEYS.roleChangePolicy)).toBe('approval');

    c.setShellApprovalMode('allow_all');
    expect(() => c.setShellApprovalMode(bogus)).toThrow(/Invalid shell approval mode/);
    expect(c.getShellApprovalMode()).toBe('allow_all');

    c.setAdvisorMinSeverity('blocker');
    expect(() => c.setAdvisorMinSeverity(bogus)).toThrow(/Invalid advisor severity/);
    expect(c.getAdvisorMinSeverity()).toBe('blocker');
  });

  test('shellApprovalGrants: empty by default, dedupes, revokes, survives garbage', () => {
    const c = setup();
    expect(c.getShellApprovalGrants()).toEqual([]);

    c.grantShellApproval([{ rule: 'rm-recursive', executor: 'device' }]);
    c.grantShellApproval([
      { rule: 'rm-recursive', executor: 'device' },
      { rule: 'sudo', executor: 'parent' },
    ]);
    expect(c.getShellApprovalGrants()).toEqual([
      { rule: 'rm-recursive', executor: 'device' },
      { rule: 'sudo', executor: 'parent' },
    ]);

    c.revokeShellApproval([
      { rule: 'rm-recursive', executor: 'device' },
      { rule: 'nothing', executor: 'nowhere' },
    ]);
    expect(c.getShellApprovalGrants()).toEqual([{ rule: 'sudo', executor: 'parent' }]);

    // An unparseable value must never widen what runs.
    c.set(AGENT_CONFIG_KEYS.shellApprovalGrants, 'bogus,@,rule@,,sudo@device');
    expect(c.getShellApprovalGrants()).toEqual([{ rule: 'sudo', executor: 'device' }]);

    c.revokeShellApproval([{ rule: 'sudo', executor: 'device' }]);
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

    // A percentage is a caller bug; clamping to 1 would run every turn in shadow.
    expect(() => c.setShadowSampleRate(100)).toThrow(/invalid shadow_sample_rate/);
    expect(() => c.setScaffoldExploreShare(-0.1)).toThrow(/invalid scaffold_explore_share/);
    expect(() => c.setShadowSampleRate(Number.NaN)).toThrow(/invalid shadow_sample_rate/);
    expect(c.getShadowSampleRate()).toBe(0.5);

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

  test('a rejected multi-knob write leaves prior knobs untouched', () => {
    const c = setup();
    c.setMctsOverrides({ explorationWeight: 2 });
    expect(() => c.setMctsOverrides({ explorationWeight: 1.2, budget: -1 })).toThrow(/invalid MCTS setting/);
    expect(c.getMctsOverrides()).toEqual({ explorationWeight: 2 });
  });

  test('rejects an integer knob that floors to zero without storing it', () => {
    const c = setup();
    expect(() => c.setMctsOverrides({ budget: 0.5 })).toThrow(/invalid MCTS setting/);
    expect(c.getMctsOverrides()).toEqual({});
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
    // Below the floor a disjoint split is impossible.
    c.set(AGENT_CONFIG_KEYS.gepaEvalBudget, '1');
    expect(c.getGepaEvalBudget()).toBe(4);
    c.set(AGENT_CONFIG_KEYS.gepaEvalBudget, 'many');
    expect(c.getGepaEvalBudget()).toBe(DEFAULT_GEPA_EVAL_BUDGET);
  });
});

describe('AgentConfigStore — lifetime counters', () => {
  test('a fresh store counts from one and writes only its own key', () => {
    const c = setup();
    expect(c.countClosedTurnWindow()).toBe(1);
    expect(Object.keys(c.all())).toEqual([AGENT_CONFIG_KEYS.closedTurnWindows]);
    expect(c.countClosedTurnWindow()).toBe(2);
    expect(c.countClosedTurnWindow()).toBe(3);
    expect(c.get(AGENT_CONFIG_KEYS.closedTurnWindows)).toBe('3');
  });

  test('counts on over the inline runtime, whose writes answer their RETURNING rows as DO storage.sql does', () => {
    const { sql, execRaw } = wrapDatabase(new Database(':memory:'));
    const c = createTestActor(sql, execRaw, crypto.randomUUID(), 'inline-config').config;

    expect([c.countClosedTurnWindow(), c.countClosedTurnWindow(), c.countIsolateGeneration()]).toEqual([1, 2, 1]);
  });

  test('an unreadable counter row resumes from one rather than throwing', () => {
    // Callers use the return value, so a poisoned row must still answer a number.
    const c = setup();
    c.set(AGENT_CONFIG_KEYS.closedTurnWindows, 'lots');
    expect(c.countClosedTurnWindow()).toBe(1);
    c.set(AGENT_CONFIG_KEYS.isolateGen, '');
    expect(c.countIsolateGeneration()).toBe(1);
  });

  test('the two counters are independent', () => {
    const c = setup();
    expect(c.countClosedTurnWindow()).toBe(1);
    expect(c.countIsolateGeneration()).toBe(1);
    expect(c.countIsolateGeneration()).toBe(2);
    expect(c.countClosedTurnWindow()).toBe(2);
  });
});

/** Every config key must have a real write path, checked by invoking each writer against a real store. */
describe('AgentConfigStore — every key has a write path', () => {
  const WRITERS: ReadonlyArray<(c: ReturnType<typeof setup>) => void> = [
    (c) => c.setModel('openai/gpt-5'),
    (c) => c.setReasoningEffort('high'),
    (c) => c.setCacheRetention('long'),
    (c) => c.setDisplayName('Ada'),
    (c) => c.setNameOrigin('user'),
    (c) => c.setRoleChangePolicy('approval'),
    (c) => c.setRoleSelection('auditor'),
    (c) => c.setAssignedTier('deep'),
    (c) => c.setShellApprovalMode('allow_all'),
    (c) => c.grantShellApproval([{ rule: 'rm-recursive', executor: 'device' }]),
    (c) => c.setSleepTimeComputeEnabled(false),
    (c) => c.setAutoPromoteScaffold(false),
    (c) => c.setShadowSampleRate(0.5),
    (c) => c.setScaffoldExploreShare(0.3),
    (c) => c.setAdvisorEnabled(true),
    (c) => c.setAdvisorMinSeverity('blocker'),
    (c) => c.setAlwaysActiveSkills(['research']),
    (c) => c.setLastActiveExecutor('sandbox'),
    (c) => c.setAutoGepaEveryNTurns(10),
    (c) => c.setChangelogSeenAt(1_750_000_000_000),
    (c) => c.countClosedTurnWindow(),
    (c) => c.countIsolateGeneration(),
    (c) => c.setGepaEvalBudget(16),
    (c) => c.setMctsOverrides({
      explorationWeight: 1.2, budget: 8, maxDepth: 4,
      branches: 3, judgeSamples: 2, maxEvalLLMCalls: 5,
    }),
    (c) => c.setEmailNotificationsEnabled(false),
    (c) => { canonicalConversationId(c); },
  ];

  /** Written through generic `set` from outside the store (memory-sync's Vectorize backfill). */
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
    // Negative control: dropping one writer surfaces its key as unwritable.
    const c = setup();

    for (const write of WRITERS.slice(1)) write(c);
    const written = new Set([...Object.keys(c.all()), ...GENERIC_WRITE_PATH]);
    expect(Object.values(AGENT_CONFIG_KEYS).filter((k) => !written.has(k)))
      .toEqual([AGENT_CONFIG_KEYS.model]);
  });
});

describe('the canonical conversation id lives under its registered key', () => {
  test('first open adopts default through AGENT_CONFIG_KEYS, later opens read it back', () => {
    expect(Object.values(AGENT_CONFIG_KEYS)).toContain('conversation.id');
    const c = setup();
    expect(canonicalConversationId(c)).toBe('default');
    expect(c.get(AGENT_CONFIG_KEYS.conversationId)).toBe('default');
    expect(canonicalConversationId(c)).toBe('default');
  });
});

describe('the hired assignment a child reads at its turn boundary', () => {
  test('role and tier round-trip through the typed accessors', () => {
    const c = setup();
    c.setRoleSelection('auditor');
    c.setAssignedTier('deep');
    expect(c.getRoleSelection()).toBe('auditor');
    expect(c.getAssignedTier()).toBe('deep');
  });

  test('an unpinned tier reads null — the instruction to derive from the role', () => {
    // Null means nothing was pinned, so the role's own default tier is re-derived.
    const c = setup();
    c.setRoleSelection('auditor');
    expect(c.getAssignedTier()).toBeNull();
  });

  test('clearing the pin returns the child to its role\'s own tier', () => {
    const c = setup();
    c.setAssignedTier('fast');
    expect(c.getAssignedTier()).toBe('fast');
    c.setAssignedTier(null);
    expect(c.getAssignedTier()).toBeNull();
    expect(c.get(AGENT_CONFIG_KEYS.assignedTier)).toBeNull();
  });

  test('a malformed stored tier reads as unpinned, never as a throw', () => {
    // Well-formed tier existence is checked at the turn boundary (`resolveTurnProfile`).
    const c = setup();
    c.set(AGENT_CONFIG_KEYS.assignedTier, 'Not A Tier!');
    expect(c.getAssignedTier()).toBeNull();
    c.set(AGENT_CONFIG_KEYS.assignedTier, 'gargantuan');
    expect(c.getAssignedTier()).toBe('gargantuan');
  });

  test('setAssignedTier refuses a malformed id instead of storing a hidden row', () => {
    const c = setup();
    c.setAssignedTier('deep');
    const tier = JSON.parse('"Gargantuan Tier"');
    expect(() => c.setAssignedTier(tier)).toThrow(/Invalid assigned tier/);
    expect(c.getAssignedTier()).toBe('deep');
    expect(c.get(AGENT_CONFIG_KEYS.assignedTier)).toBe('deep');
  });

  const unreadableRoles = [
    { name: 'a malformed role_selection row reads as general and is left alone', stored: 'not json' },
    { name: 'an unknown role id still reads as general and the read leaves the row alone', stored: 'Not A Role!!' },
  ] as const;

  for (const unreadable of unreadableRoles) {
    test(unreadable.name, () => {
      const c = setup();

      c.set(AGENT_CONFIG_KEYS.roleSelection, unreadable.stored);
      expect(c.getRoleSelection()).toBe('task');
      expect(c.get(AGENT_CONFIG_KEYS.roleSelection)).toBe(unreadable.stored);
    });
  }

  test('a valid custom id reads as itself', () => {
    const c = setup();
    c.set(AGENT_CONFIG_KEYS.roleSelection, 'field-researcher');
    expect(c.getRoleSelection()).toBe('field-researcher');
  });

  test('a read never mints a role row; only an explicit selection persists one', () => {
    const c = setup();
    expect(c.getRoleSelection()).toBe('task');
    expect(c.all()).toEqual({});

    c.setRoleSelection('researcher');
    expect(Object.keys(c.all())).toEqual([AGENT_CONFIG_KEYS.roleSelection]);
    expect(c.get(AGENT_CONFIG_KEYS.roleSelection)).toBe('researcher');
  });
});
