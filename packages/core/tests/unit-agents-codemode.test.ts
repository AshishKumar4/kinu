// The `agents.*` codemode namespace: the delegation operations, gated by wiring as the native tool is.
// Real sandbox execution is covered in the two backend suites.
import { describe, expect, test } from 'bun:test';
import { createTestRuntime, present, unobservedSearchSeams } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';
import { MockLanguageModelV3 } from 'ai/test';
import { asSchema } from 'ai';
import * as v from 'valibot';
import {
  createAgentsCodemodeProvider,
  createAgentsTool,
  delegationChoices,
  resolveTurnProfile,
  validateSwarmProfileSnapshot,
  profileCatalogDigest,
  BUILTIN_PROFILE_CATALOG,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  type CodemodeProvider,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  type AgentsSwarmDeps,
  type AgentsToolDeps,
} from '../src/index';
import { makeTeam, makePeers, rosterEntry } from './helpers-agents';

const ErrorResultSchema = v.object({ error: v.string() });

const SpawnCallInputSchema = v.object({
  role: v.string(),
  tier: v.optional(v.string()),
});

/** The namespace as sandbox code sees it: one callable per exposed member. */
function namespaceOf(deps: () => TestAgentsToolDeps) {
  const provider = createAgentsCodemodeProvider(() => withBuildMode(deps()));
  expect(provider.name).toBe('agents');

  return provider.tools;
}

function member(tools: CodemodeProvider['tools'], name: string) {
  const descriptor = tools[name];

  if (!descriptor) throw new Error(`missing agents.${name}`);

  return descriptor;
}

/** `swarms` defaults on: these suites pin the tool as it stands with "Beta: swarms" turned on. */
type TestAgentsToolDeps = Omit<AgentsToolDeps, 'mode' | 'swarms'> & Partial<Pick<AgentsToolDeps, 'mode' | 'swarms'>>;

function withBuildMode(deps: TestAgentsToolDeps): AgentsToolDeps {
  return { mode: 'build', swarms: true, ...deps };
}

/**
 * The swarm substrate with `resolveModel` wired, which a profile catalog requires. Tier routing is pinned in
 * unit-swarm-profile-routing.test.ts.
 */
function swarmDeps(overrides: Partial<AgentsSwarmDeps> = {}): AgentsSwarmDeps {
  const { rt, testSql } = createTestRuntime();
  const model = new MockLanguageModelV3();

  return {
    rt, model: () => model, resolveModel: () => model,
    // One hosted actor per node id, all over the one workspace database.
    hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
    ...unobservedSearchSeams(),
    ...overrides,
  };
}

function fullDeps(): AgentsToolDeps {
  return withBuildMode({ swarm: swarmDeps(), team: makeTeam().deps, peers: makePeers().deps });
}

/** The operations the native tool offers under the same wiring. */
function nativeOps(deps: AgentsToolDeps): string[] {
  return v.parse(v.object({ properties: v.object({ op: v.object({ enum: v.array(v.string()) }) }) }),
    asSchema(createAgentsTool(deps).inputSchema).jsonSchema).properties.op.enum;
}

describe('agents.* codemode namespace — dep gating', () => {
  test('the namespace offers exactly the operations the native tool does, whatever the wiring', () => {
    for (const deps of [withBuildMode({ swarm: swarmDeps() }), fullDeps(), withBuildMode({ team: makeTeam().deps })]) {
      expect(Object.keys(namespaceOf(() => deps))).toEqual(nativeOps(deps));
    }

    expect(Object.keys(namespaceOf(() => ({ swarm: swarmDeps() })))).toEqual(['swarm']);
    expect(Object.keys(namespaceOf(() => ({ team: makeTeam().deps })))).toEqual(['hire', 'assign', 'message', 'list', 'dismiss']);
  });

  test('the declarations expose no elapsed deadline field', () => {
    const declared = JSON.stringify(createAgentsCodemodeProvider(() => fullDeps()).declarations);
    expect(declared).not.toContain('timeout_seconds');
    expect(declared).not.toContain('timeoutMs');
  });
});

describe('agents.* codemode namespace — dispatch', () => {
  test('a Plan provider keeps its trusted mode after the host advances to Build', async () => {
    const team = makeTeam();
    let currentMode: 'plan' | 'build' = 'plan';
    const provider = createAgentsCodemodeProvider(() => ({ mode: currentMode, swarms: true, team: team.deps }));
    currentMode = 'build';

    await member(provider.tools, 'message').execute('researcher', 'inspect only');

    expect(team.calls[0]).toMatchObject({
      action: 'message',
      input: { mode: 'plan', name: 'researcher', content: 'inspect only' },
    });
  });

  test('Plan mode does not narrow the search surface', async () => {
    // Plan mode constrains what a helper may do, never which members exist.
    const provider = createAgentsCodemodeProvider(() => ({ mode: 'plan', swarms: true, swarm: swarmDeps() }));
    expect(await member(provider.tools, 'swarm').execute('research')).toMatchObject({ reason: 'bad_input' });
    expect(Object.keys(provider.tools))
      .toEqual(Object.keys(createAgentsCodemodeProvider(() => withBuildMode({ swarm: swarmDeps() })).tools));
  });

  test('the search contract is the native tool\'s: the same refusals, by field', async () => {
    const ns = namespaceOf(() => ({ swarm: swarmDeps() }));
    expect(await member(ns, 'swarm').execute('t')).toMatchObject({ reason: 'bad_input' });

    const stale = v.parse(ErrorResultSchema, await member(ns, 'swarm').execute('t', { settle: 'mcts', preset: 'ideate' }));

    expect(stale.error).toContain('no option settle');
  });

  test('typed search fields reach the dispatch exactly as the tool sends them', async () => {
    const ns = namespaceOf(() => ({ swarm: swarmDeps() }));

    const refused = v.parse(v.object({ reason: v.string(), error: v.string() }), await member(ns, 'swarm').execute('ship it', {
      preset: 'ideate',
      objective: {
        kind: 'scalar', metric: 'ms', unit: 'ms', direction: 'minimise', scale: 'linear',
        target: 1, verify: { kind: 'exec-ratio', spec: {} },
      },
    }));

    expect(refused.reason).toBe('bad_input');
    // The axis refusal, not a parse complaint: the nested objective arrived whole.
    expect(refused.error).toMatch(/`ideate` is flat and has no value signal/);
  });

  test('hire / assign / message / reply / list / dismiss reach the same transports', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const deps = withBuildMode({ swarm: swarmDeps(), team: team.deps, peers: peers.deps, profile: profileDeps().profile });
    const ns = namespaceOf(() => deps);

    expect(await member(ns, 'hire').execute('researcher', 'Map the landscape'))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(await member(ns, 'assign').execute('researcher', 'Survey auth', { deliverable: 'a note' }))
      .toMatchObject({ status: 'working', agent: 'researcher' });
    expect(await member(ns, 'message').execute('researcher', 'also check the CLI'))
      .toMatchObject({ status: 'delivered', agent: 'researcher', delivery: 'starts_now', event_id: 'evt-starts_now' });
    expect(await member(ns, 'reply').execute('pe1', 'here you go')).toEqual({ ok: true });
    expect(await member(ns, 'list').execute()).toEqual({ subordinates: [rosterEntry], peers: [{ name: 'scout', displayName: 'Scout' }] });
    expect(await member(ns, 'dismiss').execute('researcher'))
      .toEqual({ ok: true, name: 'researcher', historyKept: true, stoppedJobs: [] });

    expect(team.calls.map((c) => c.action)).toEqual(['spawn', 'assign', 'message', 'dismiss']);
    expect(peers.calls.map((c) => c.action)).toEqual(['reply']);
  });

  test('a peer assignment from the sandbox rides the peer transport without a deadline', async () => {
    const peers = makePeers();
    const ns = namespaceOf(() => ({ peers: peers.deps }));
    expect(await member(ns, 'assign').execute('scout', 'What changed?', { topic: 'research' }))
      .toEqual({ status: 'replied', from: 'scout', reply: 'answer' });
    expect(peers.calls[0].input).toEqual({
      agent: 'scout', topic: 'research', message: 'What changed?', mode: 'build',
    });
  });

  test('deps are read per call, so a re-bound model/session lands without a rebuild', async () => {
    let generation = 0;

    const ns = namespaceOf(() => {
      generation += 1;
      const { rt, testSql } = createTestRuntime();

      return {
        swarm: {
          rt, model: () => new MockLanguageModelV3(),
          hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
          ...unobservedSearchSeams(),
        },
      };
    });

    // Each call rebuilds the deps, so the second call sees the later binding.
    await member(ns, 'swarm').execute('a');
    await member(ns, 'swarm').execute('b');
    expect(generation).toBe(4);
  });

  test('deps failures come back as inspectable values, never thrown into the script', async () => {
    const team = makeTeam();
    team.deps.spawn = async () => { throw new Error('kaboom'); };

    const ns = namespaceOf(() => ({ team: team.deps, profile: profileDeps().profile }));
    const result = v.parse(ErrorResultSchema, await member(ns, 'hire').execute('researcher', 'map the landscape'));

    expect(result.error).toMatch(/kaboom/);
  });

  test('a direct model spec is refused on hire and swarm, naming the field', async () => {
    const ns = namespaceOf(() => profileDeps());

    expect(v.parse(ErrorResultSchema, await member(ns, 'hire').execute('researcher', 'm', { model: 'openai/gpt' })).error).toContain('model');
    expect(v.parse(ErrorResultSchema, await member(ns, 'swarm').execute('t', { preset: 'ideate', model: 'openai/gpt' })).error).toContain('model');
  });
});

const TEST_MODEL = DEFAULT_WORKERS_AI_MODEL_SPEC;

const TIERED_CATALOG = {
  roles: BUILTIN_PROFILE_CATALOG.roles,
  tiers: {
    default: { model: TEST_MODEL },
    fast: { model: TEST_MODEL },
    deep: { model: TEST_MODEL },
  },
};

function builtinEnvelope() {
  return {
    authority: { kind: 'local' } as const,
    version: 0,
    digest: profileCatalogDigest(TIERED_CATALOG),
    catalog: TIERED_CATALOG,
  };
}

function profileDeps(overrides: Partial<AgentsToolDeps> = {}): TestAgentsToolDeps {
  return {
swarm: swarmDeps(),
    team: makeTeam().deps,
    profile: () => ({
      envelope: builtinEnvelope(),
      provider: { revision: 'test-1', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
      roleId: 'task',
      availableTools: [],
      pins: {},
    }),
    ...overrides,
  };
}

describe('agents delegation — role/tier/preset precedence', () => {
  test('hire resolves an explicit role through the catalog: role default tier, provenance recorded', async () => {
    const team = makeTeam();
    const tools = namespaceOf(() => profileDeps({ team: team.deps }));
    await member(tools, 'hire').execute('researcher', 'map the landscape');
    const call = present(team.calls.find((c) => c.action === 'spawn'), 'the spawn call');
    const input = v.parse(SpawnCallInputSchema, call.input);
    expect(input.role).toBe('researcher');
    // The role-default tier is not stored; the child re-derives it from its roleId. Only an explicit override
    // rides along.
    expect(input.tier).toBeUndefined();
  });

  test('an explicit tier override rides to the identity; a spawn-forbidden role is refused', async () => {
    const team = makeTeam();
    const tools = namespaceOf(() => profileDeps({ team: team.deps }));
    await member(tools, 'hire').execute('planner', 'plan', { tier: 'deep' });

    const input = v.parse(
      SpawnCallInputSchema,
      present(team.calls.find((call) => call.action === 'spawn'), 'the spawn call').input,
    );

    expect(input.tier).toBe('deep');

    const restrictedCatalog = {
      roles: {
        ...BUILTIN_PROFILE_CATALOG.roles,
        lead: {
          description: 'd',
          instructions: 'i',
          tier: 'default',
          preset: 'ideate',
          spawns: ['researcher'],
        },
      },
      tiers: BUILTIN_PROFILE_CATALOG.tiers,
    } satisfies ProfileCatalog;

    const envelope = {
      ...builtinEnvelope(),
      version: 1,
      catalog: restrictedCatalog,
      digest: profileCatalogDigest(restrictedCatalog),
    } satisfies ProfileCatalogEnvelope;

    const restricted = profileDeps({
      team: makeTeam().deps,
      profile: () => ({
        envelope,
        provider: { revision: 'test-1', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
        roleId: 'lead',
        availableTools: [],
        pins: {},
      }),
    });

    const tools2 = namespaceOf(() => restricted);
    const refused = await member(tools2, 'hire').execute('auditor', 'x');
    expect(refused).toMatchObject({ reason: 'bad_input' });
    expect(v.parse(ErrorResultSchema, refused).error).toContain('auditor');
  });

  test('a role-homogeneous swarm takes its preset from the role when omitted', async () => {
    // Resolution ran: with the role's default preset, an objective-less ideate run fails at expansion, not at
    // `preset`.
    const deps = profileDeps();
    const tools = namespaceOf(() => deps);
    const noPreset = await member(tools, 'swarm').execute('explore angles');
    // researcher is not the caller (general), so this resolves general→ideate.
    expect(noPreset).not.toMatchObject({ reason: 'bad_input', error: expect.stringContaining('preset') });
    const swarm = deps.swarm;

    if (!swarm) throw new Error('profile test needs the swarm substrate');

    const row = swarm.rt.storage.sql<{ config_json: string }>`
      SELECT config_json FROM mcts_search_runs ORDER BY created_at DESC LIMIT 1
    `[0];

    if (!row) throw new Error('swarm did not persist its resolved config');
    const config = v.parse(v.object({ profile: v.unknown() }), JSON.parse(row.config_json));
    expect(validateSwarmProfileSnapshot({ value: config.profile }).sources.presetSource).toBe('role_default');
  });

  test('without a wired catalog, swarm demands an explicit preset and hire refuses', async () => {
    const tools = namespaceOf(() => ({ swarm: swarmDeps(), team: makeTeam().deps }));
    const refused = await member(tools, 'swarm').execute('angles only');
    expect(refused).toMatchObject({ reason: 'bad_input' });
    expect(v.parse(ErrorResultSchema, refused).error).toContain('preset');

    const team = makeTeam();
    const noCatalog = namespaceOf(() => ({ swarm: swarmDeps(), team: team.deps }));
    const hireRefused = await member(noCatalog, 'hire').execute('researcher', 'scan');
    expect(hireRefused).toMatchObject({ reason: 'denied' });
    expect(team.calls).toEqual([]);
  });

  test('role summaries reach the step context from the catalog, never the shared native schema', () => {
    const rendered = (deps: TestAgentsToolDeps): string =>
      JSON.stringify(createAgentsTool(withBuildMode(deps)).inputSchema);

    const deps = profileDeps();
    expect(rendered(deps)).not.toContain('researcher');
    expect(delegationChoices(deps.profile?.() ?? null)?.roles.some((role) => role.startsWith('researcher: '))).toBe(true);
    // No catalog wired: no choices, and nothing invented.
    expect(delegationChoices(null)).toBeNull();
  });
});

describe('swarm profile snapshot codec', () => {
  test('a resolved profile survives JSON round-trip through the ledger gate', () => {
    const resolved = resolveTurnProfile({
      envelope: builtinEnvelope(),
      provider: { revision: 'rev-1', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
      roleId: 'researcher',
      workMode: 'build',
      availableTools: ['file', 'web'],
      activeSkills: [],
    });

    // The ledger stores the one complete immutable profile; re-drive never re-resolves it.
    const snapshot = {
      profile: resolved,
      sources: { roleSource: 'caller', tierSource: 'role', presetSource: 'role_default' },
    };

    const frozen = JSON.parse(JSON.stringify(snapshot));
    const readBack = validateSwarmProfileSnapshot({ value: frozen });
    expect(readBack.profile.role.id).toBe('researcher');
    expect(readBack.profile.tier.id).toBe('fast');
    expect(readBack.profile.tier.source).toBe('role');
    expect(readBack.sources.presetSource).toBe('role_default');
    expect(() => validateSwarmProfileSnapshot({ value: { ...frozen, sources: { ...frozen.sources, tierSource: 'bogus' } } }))
      .toThrow(/snapshot/);

    // A swarm frozen before tiers had fallbacks re-drives with none, not as a refused snapshot.
    const { fallbacks: _omitted, ...tierBefore } = frozen.profile.tier;
    const before = { ...frozen, profile: { ...frozen.profile, tier: tierBefore } };
    expect(validateSwarmProfileSnapshot({ value: before }).profile.tier.fallbacks).toEqual([]);
  });
});
