// The `agents.*` codemode namespace: the delegation tool projected into the sandbox, gated by agentsActionsFor.
// Real sandbox execution is covered in the two backend suites.
import { describe, expect, test } from 'bun:test';
import { createTestRuntime, present } from '@kinu.run/test-utils';
import { hostedSeatsOver, refuseHostNode } from './helpers-actor-host';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  AGENTS_TOOL_ACTIONS,
  agentsActionsFor,
  createAgentsCodemodeProvider,
  createAgentsTool,
  decodeJsonValue,
  parseAgentsToolInput,

  resolveTurnProfile,
  validateSwarmProfileSnapshot,
  profileCatalogDigest,
  BUILTIN_PROFILE_CATALOG,
  DEFAULT_WORKERS_AI_MODEL_SPEC,
  type CodemodeProvider,
  type JsonValue,
  type ProfileCatalog,
  type ProfileCatalogEnvelope,
  SWARM_PRESET_DOCTRINE,
  type AgentsSwarmDeps,
  type AgentsToolDeps,
  type PeersToolDeps,
  type SubordinateRosterEntry,
  type TeamToolDeps,
  type SubordinateDelivery, type SubordinateHandoff,
} from '../src/index';
import {
  AGENTS_ACTION_FIELDS as ACTION_FIELDS,
  agentsActionFieldsFor,
  agentsActionInputVariantsFor,
  dispatchAgentsAction,
} from '../src/delegation/agents-tool';
import { ROOT_DELEGATION_BUDGET } from '../src/subordinates/depth';
import { NAMED_SWARM_PRESETS, SWARM_PRESETS } from '../src/strategy/swarm';

interface Call { action: string; input: JsonValue }

const ErrorResultSchema = v.object({ error: v.string() });

const AgentsInputSchemaContract = v.object({
  jsonSchema: v.object({
    properties: v.object({
      action: v.object({ enum: v.array(v.string()) }),
    }),
  }),
});

const ToolSchemaContract = v.object({
  jsonSchema: v.object({
    properties: v.record(v.string(), v.unknown()),
  }),
});

const ActionVariantSchemaContract = v.object({
  jsonSchema: v.object({
    oneOf: v.array(v.object({
      properties: v.object({
        action: v.object({ const: v.string() }),
        scope: v.union([v.object({ const: v.string() }), v.literal(false)]),
      }),
      required: v.array(v.string()),
    })),
  }),
});

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

function recordCall(calls: Call[], action: string, call: { input: unknown }): void {
  calls.push({ action, input: decodeJsonValue({ value: call.input }) });
}

interface HandoffEcho {
  action: string;
  input: { name: string };
  delivery: SubordinateDelivery;
  busy: boolean;
}

/** Record the call and answer with the handoff its action reports. */
function echoHandoff(calls: Call[], echo: HandoffEcho) {
  recordCall(calls, echo.action, { input: echo.input });

  return { ok: true as const, name: echo.input.name, ...handoff(echo.delivery, echo.busy) };
}

type TestAgentsToolDeps = Omit<AgentsToolDeps, 'mode'> & { mode?: AgentsToolDeps['mode'] };

function withBuildMode(deps: TestAgentsToolDeps): AgentsToolDeps {
  return { mode: 'build', ...deps };
}

/**
 * The swarm substrate with `resolveModel` wired, which a profile catalog requires. Tier routing is pinned in
 * unit-swarm-profile-routing.test.ts.
 */
function swarmDeps(overrides: Partial<AgentsSwarmDeps> = {}): AgentsSwarmDeps {
  const { rt, testSql } = createTestRuntime();
  const model = new MockLanguageModelV3();

  return {
    rt, model, resolveModel: () => model,
    // One hosted actor per node id, all over the one workspace database.
    hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
    ...overrides,
  };
}

const rosterEntry: SubordinateRosterEntry = { name: 'researcher', actorReference: null, birth: null, deleteRequested: false, createdBy: 'orchestrator', status: 'idle', currentTask: null, createdAt: 1000, dismissedAt: null, lifetime: 'durable', taskEventId: null };

const handoff = (delivery: SubordinateDelivery, busy: boolean): SubordinateHandoff => ({
  eventId: `evt-${delivery}`,
  delivery,
  phase: { busy, lastActivityAt: 1234, workingOn: busy ? 'reading src/auth.ts' : null },
});

function makeTeam() {
  const calls: Call[] = [];

  return {
    calls,
    deps: {
      delegation: ROOT_DELEGATION_BUDGET,
      temporary: {
        run: async () => ({
          status: 'completed' as const,
          agent: 'ask-auditor-x',
          lifetime: 'task' as const,
          role: 'auditor',
          answer: 'answered',
          transcript: 'kept' as const,
          elapsed_ms: 1,
        }),
        settle: () => false,
      },
      snapshot: () => [rosterEntry],
      list: async () => [rosterEntry],
      create: async (input) => ({
        name: input.name ?? 'researcher',
        displayName: 'Researcher',
        subordinate: { name: input.name ?? 'researcher', displayName: 'Researcher', role: input.role ?? 'task', actorReference: null, birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
      }),
      rename: async (input) => {
        recordCall(calls, 'rename', { input });

        return {
          ok: true, name: input.name, displayName: input.displayName,
          subordinate: { ...rosterEntry, name: input.name, displayName: input.displayName },
        };
      },
      recordTitle: async (input) => {
        recordCall(calls, 'recordTitle', { input });

        return { ok: true, name: input.name, displayName: input.displayName, applied: true };
      },
      spawn: async (input) => {
        recordCall(calls, 'spawn', { input });

        return { name: input.name ?? 'researcher', displayName: 'Researcher' };
      },
      assign: async (input) => echoHandoff(calls, {
        action: 'assign', input, delivery: 'queued', busy: true,
      }),
      knows: async () => true,
      status: async (input) => {
        recordCall(calls, 'status', { input });

        return { roster: [rosterEntry] };
      },
      message: async (input) => echoHandoff(calls, {
        action: 'message', input, delivery: 'starts_now', busy: false,
      }),
      dismiss: async (input) => {
        recordCall(calls, 'dismiss', { input });

        return { ok: true, name: input.name, historyKept: input.keepHistory ?? false };
      },
    } satisfies TeamToolDeps,
  };
}

function makePeers() {
  const calls: Call[] = [];

  return {
    calls,
    deps: {
      listPeers: async () => [{ name: 'scout', displayName: 'Scout' }],
      ask: async (input) => {
        recordCall(calls, 'ask', { input });

        return { status: 'replied', from: input.agent, reply: 'answer' };
      },
      send: async (input) => {
        recordCall(calls, 'send', { input });

        return { status: 'delivered', message_id: 'ox1' };
      },
      reply: async (input) => {
        recordCall(calls, 'reply', { input });

        return { ok: true };
      },
      spawnWorkspace: async (input) => {
        recordCall(calls, 'spawn_workspace', { input });

        return { agent: input.name ?? 'specialist', created: true, status: 'replied', from: 'specialist', reply: 'done' };
      },
    } satisfies PeersToolDeps,
  };
}

function fullDeps(): AgentsToolDeps {
  return withBuildMode({ swarm: swarmDeps(), team: makeTeam().deps, peers: makePeers().deps });
}

function actionEnumOf(deps: TestAgentsToolDeps): string[] {
  const schema = v.parse(
    AgentsInputSchemaContract,
    createAgentsTool(withBuildMode(deps)).inputSchema,
  );

  return schema.jsonSchema.properties.action.enum;
}

describe('agents.* codemode namespace — dep gating', () => {
  test('the exploration substrate (CLI / subordinate) exposes the search member alone', () => {
    const deps = withBuildMode({ swarm: swarmDeps() });
    // `swarm` needs a model and a workspace; with both, the namespace exposes it.
    expect(Object.keys(namespaceOf(() => deps))).toEqual(['swarm']);
  });

  test('full deps (the workspace orchestrator) expose every action', () => {
    const deps = fullDeps();
    expect(Object.keys(namespaceOf(() => deps))).toEqual([...AGENTS_TOOL_ACTIONS]);
  });

  test('team-without-peers keeps the subordinate verbs', () => {
    const deps = withBuildMode({ team: makeTeam().deps });
    expect(Object.keys(namespaceOf(() => deps))).toEqual(['hire', 'msg', 'list', 'dismiss']);
  });

  test('the namespace members ARE the tool action enum — one gate, never two', () => {
    for (const deps of [withBuildMode({ swarm: swarmDeps() }), fullDeps(), withBuildMode({ team: makeTeam().deps })]) {
      expect(Object.keys(namespaceOf(() => deps))).toEqual(actionEnumOf(deps));
      expect(Object.keys(namespaceOf(() => deps))).toEqual(agentsActionsFor(deps));
    }
  });

  test('the codemode declaration exposes no elapsed deadline field', () => {
    const provider = createAgentsCodemodeProvider(() => fullDeps());
    expect(provider.types).not.toContain('timeout_seconds');
    expect(provider.types).not.toContain('timeoutMs');
  });

  test('an ungated action is structurally absent, not a runtime refusal', () => {
    const ns = namespaceOf(() => ({ swarm: swarmDeps() }));
    expect(ns.hire).toBeUndefined();
    expect(ns.msg).toBeUndefined();
  });
});

describe('agents.* codemode namespace — dispatch', () => {
  test('a Plan provider keeps its trusted mode after the host advances to Build', async () => {
    const team = makeTeam();
    let currentMode: 'plan' | 'build' = 'plan';
    const provider = createAgentsCodemodeProvider(() => ({ mode: currentMode, team: team.deps }));
    currentMode = 'build';

    await member(provider.tools, 'msg').execute({ agent: 'researcher', message: 'inspect only' });

    expect(team.calls[0]).toMatchObject({
      action: 'message',
      input: { mode: 'plan', name: 'researcher', content: 'inspect only' },
    });
  });

  test('Plan mode does not narrow the search surface', async () => {
    // Plan mode constrains what a helper may do, never which members exist.
    const provider = createAgentsCodemodeProvider(() => ({ mode: 'plan', swarm: swarmDeps() }));
    expect(await member(provider.tools, 'swarm').execute({ task: 'research' }))
      .toMatchObject({ reason: 'bad_input' });
    expect(Object.keys(provider.tools))
      .toEqual(Object.keys(createAgentsCodemodeProvider(() => withBuildMode({ swarm: swarmDeps() })).tools));
  });

  test('the search contract is the tool\'s, not re-implemented here', async () => {
    // Same dispatch, same classified refusals: no preset is refused, and `settle` is refused as an unknown
    // field.
    const ns = namespaceOf(() => ({ swarm: swarmDeps() }));
    expect(await member(ns, 'swarm').execute({ task: 't' })).toMatchObject({ reason: 'bad_input' });

    const stale = v.parse(ErrorResultSchema, await member(ns, 'swarm').execute({
      task: 't', settle: 'mcts', preset: 'ideate',
    }));

    expect(stale.error).toContain('unknown field "settle"');
    expect(stale.error).toContain(
      'action "swarm" takes: task, preset, objective, key, config, from, label, name, branches, '
      + 'depth, nodes, models, role, tier, budget_usd, budget_tokens, budget_label',
    );
  });

  test('typed search fields reach the dispatch exactly as the tool sends them', async () => {
    // The same parsed input reaches the same dispatcher; no second parse lives in the sandbox bridge.
    const ns = namespaceOf(() => ({ swarm: swarmDeps() }));

    const refused = v.parse(v.object({ reason: v.string(), error: v.string() }), await member(ns, 'swarm').execute({
      task: 'ship it',
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

  test('hire / msg / list / dismiss reach the same transports', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const deps = withBuildMode({ swarm: swarmDeps(), team: team.deps, peers: peers.deps, profile: profileDeps().profile });
    const ns = namespaceOf(() => deps);

    expect(await member(ns, 'hire').execute({ role: 'researcher', mission: 'Map the landscape' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(await member(ns, 'hire').execute({ agent: 'researcher', message: 'Survey auth', deliverable: 'a note' }))
      .toMatchObject({ status: 'working', agent: 'researcher' });
    expect(await member(ns, 'msg').execute({ agent: 'researcher', message: 'also check the CLI' }))
      .toMatchObject({ status: 'delivered', agent: 'researcher', delivery: 'starts_now', event_id: 'evt-starts_now' });
    expect(await member(ns, 'msg').execute({ event_id: 'pe1', message: 'here you go' })).toEqual({ ok: true });
    expect(await member(ns, 'list').execute()).toEqual({ subordinates: [rosterEntry], peers: [{ name: 'scout', displayName: 'Scout' }] });
    expect(await member(ns, 'dismiss').execute({ agent: 'researcher' }))
      .toEqual({ ok: true, name: 'researcher', historyKept: true });

    expect(team.calls.map((c) => c.action)).toEqual(['spawn', 'assign', 'message', 'dismiss']);
    expect(peers.calls.map((c) => c.action)).toEqual(['reply']);
  });

  test('a peer hire from the sandbox rides the peer transport without a deadline', async () => {
    const peers = makePeers();
    const ns = namespaceOf(() => ({ peers: peers.deps }));
    expect(await member(ns, 'hire').execute({ agent: 'scout', message: 'What changed?', topic: 'research' }))
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
          rt, model: new MockLanguageModelV3(),
          hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
        },
      };
    });

    // Each call rebuilds the deps, so the second call sees the later binding.
    await member(ns, 'swarm').execute({ task: 'a' });
    await member(ns, 'swarm').execute({ task: 'b' });
    expect(generation).toBe(3);
  });

  test('deps failures come back as inspectable values, never thrown into the script', async () => {
    const team = makeTeam();
    team.deps.spawn = async () => { throw new Error('kaboom'); };

    const ns = namespaceOf(() => ({ team: team.deps, profile: profileDeps().profile }));

    const result = v.parse(ErrorResultSchema, await member(ns, 'hire').execute({
      role: 'researcher', mission: 'map the landscape',
    }));

    expect(result.error).toMatch(/kaboom/);
  });
});

describe('agents.* codemode namespace — sandbox input handling', () => {
  test('the member decides the action — a script cannot smuggle another one', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const ns = namespaceOf(() => ({ team: team.deps, peers: peers.deps }));
    // `dismiss` would archive the subordinate; the member called was `list`.
    expect(await member(ns, 'list').execute({ action: 'dismiss', agent: 'researcher' })).toEqual({ roster: [rosterEntry] });
    expect(team.calls.map((c) => c.action)).toEqual(['status']);
  });

  test('a zero-arg call on the node backend sees the exec context, not an input', async () => {
    const team = makeTeam();
    const ns = namespaceOf(() => ({ team: team.deps }));
    // The node sandbox appends `{ signal }`, so `agents.list()` arrives as list({ signal }) and must still
    // list.
    expect(await member(ns, 'list').execute({ signal: new AbortController().signal })).toEqual({ subordinates: [rosterEntry] });
    expect(team.calls).toEqual([]);
  });

  test('the retired timeout_seconds field is a sharp error', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const ns = namespaceOf(() => ({ team: team.deps, peers: peers.deps }));

    const result = v.parse(ErrorResultSchema, await member(ns, 'hire').execute({
      agent: 'researcher', message: 'go', timeout_seconds: 30,
    }));

    expect(result.error).toContain('agents.hire: unknown field "timeout_seconds"');
    expect(team.calls).toEqual([]);
  });

  test('the exec context is not read as a field, even beside the script\'s own options', async () => {
    const team = makeTeam();
    const ns = namespaceOf(() => ({ team: team.deps }));
    // The host's `{ signal }` may also trail the script's object; it must never reach the parse.
    expect(await member(ns, 'list').execute(
      { agent: 'researcher' },
      { signal: new AbortController().signal },
    )).toEqual({ roster: [rosterEntry] });
  });

  test('a malformed field is an inspectable error, never a throw into the script', async () => {
    const peers = makePeers();
    const ns = namespaceOf(() => ({ peers: peers.deps }));
    // Sandbox input has no schema validation, so a wrong-typed field comes back as a readable value.
    const result = v.parse(ErrorResultSchema, await member(ns, 'msg').execute({ agent: 'scout', message: 'hi', topic: 42 }));
    expect(result.error).toMatch(/Expected string/);
    expect(peers.calls).toEqual([]);
  });

  test('the trailing exec context carries cancellation into the search', async () => {
    // The trailing `{ signal }` is the host's and is taken out of the input; `runSwarmAction` reads
    // `abortSignal` off it.
    const ns = namespaceOf(() => ({ swarm: swarmDeps() }));
    const controller = new AbortController();

    const result = v.parse(ErrorResultSchema, await member(ns, 'swarm').execute(
      { task: 't' }, { signal: controller.signal },
    ));

    expect(result.error).toContain('swarm needs `preset`');
    expect(result.error).not.toContain('unknown field "signal"');
  });

  test('a non-object argument is a classified refusal, not a deps call', async () => {
    const team = makeTeam();
    const ns = namespaceOf(() => ({ team: team.deps }));
    // Reason first, so a script can branch on the class without parsing prose.
    expect(await member(ns, 'hire').execute('just a string'))
      .toEqual({ success: false, reason: 'bad_input', error: 'agents.hire: expects a single options object' });
    expect(await member(ns, 'dismiss').execute(['researcher']))
      .toEqual({ success: false, reason: 'bad_input', error: 'agents.dismiss: expects a single options object' });
    expect(await member(ns, 'hire').execute({ role: 'r', mission: 'm', budgetUsd: 5 }))
      .toMatchObject({ reason: 'bad_input', error: expect.stringContaining('budgetUsd') });
    expect(team.calls).toEqual([]);
  });

  test('missing required fields stay the tool\'s own sharp errors', async () => {
    const ns = namespaceOf(() => fullDeps());
    expect(await member(ns, 'msg').execute({ agent: 'researcher' }))
      .toEqual({ success: false, reason: 'bad_input', error: 'msg requires a message' });
    // The refusal carries its classification, exactly as the declared type promises.
    expect(await member(ns, 'swarm').execute({})).toEqual({ success: false, reason: 'bad_input', error: expect.stringContaining('swarm needs `preset`') });
  });

  test('native and codemode reject the same capability-inapplicable fields', async () => {
    const deps = withBuildMode(fullDeps());

    const nativeInput = parseAgentsToolInput({
      input: {
        action: 'hire',
        scope: 'workspace',
        mission: 'own the specialist workspace',
        message: 'begin',
        role: 'researcher',
      },
    });

    const native = dispatchAgentsAction(deps, nativeInput);
    await expect(native).rejects.toMatchObject({ code: 'bad_input', message: 'field "role" is not available for action "hire" on this actor' });

    const codemode = await member(namespaceOf(fullDeps), 'hire').execute({
      scope: 'workspace',
      mission: 'own the specialist workspace',
      message: 'begin',
      role: 'researcher',
    });

    expect(codemode).toEqual({ success: false, reason: 'bad_input', error: 'field "role" is not available for action "hire" on this actor' });
  });
});

describe('agents.* codemode namespace — declared types', () => {
  test('declares exactly the gated members', () => {
    const searchOnly = createAgentsCodemodeProvider(() => withBuildMode({ swarm: swarmDeps() })).types ?? '';
    expect(searchOnly).toContain('swarm(input: {');
    expect(searchOnly).not.toContain('hire(input: {');
    expect(searchOnly).not.toContain('dismiss(input: {');

    const full = createAgentsCodemodeProvider(fullDeps).types ?? '';

    for (const action of AGENTS_TOOL_ACTIONS) expect(full).toContain(`${action}(input`);
  });

  test('the search docstring states the non-resumable cost of searching in-sandbox', () => {
    const types = createAgentsCodemodeProvider(() => withBuildMode({ swarm: swarmDeps() })).types ?? '';
    expect(types).toContain('NOT resumable from here');
    expect(types).toContain('eval declines background resume');
    expect(types).toContain('top-level `agents` tool');
  });

  test('the search docstring says what is measured and what a refusal names', () => {
    // The declaration says `verify` names a registered instrument and that an illegal composition is refused by
    // name.
    const types = createAgentsCodemodeProvider(() => withBuildMode({ swarm: swarmDeps() })).types ?? '';
    expect(types).toContain('MEASURED rather than judged');
    expect(types).toContain('names a REGISTERED instrument');
    expect(types).toContain('names the axis');
    // `preset` is optional now: an omitted preset takes the role's default.
    expect(types).toMatch(/^ {4}preset\?: "ideate" \| "research"/m);
    expect(types).not.toContain('settle');
    // The refusal's classification is declared, like the file dispatcher's.
    expect(types).toContain('{ reason: string; error: string }');
  });

  test('the declared preset union is every preset the tool advertises, with the same doctrine', () => {
    // Derived from the schema, so the sandbox declaration cannot offer a different preset set.
    const types = createAgentsCodemodeProvider(() => withBuildMode({ swarm: swarmDeps() })).types ?? '';

    for (const preset of SWARM_PRESETS) expect(types).toContain(`"${preset}"`);
    expect(types).toContain(`preset?: ${SWARM_PRESETS.map((preset) => `"${preset}"`).join(' | ')};`);
    expect(types).toContain(`from?: ${NAMED_SWARM_PRESETS.map((preset) => `"${preset}"`).join(' | ')};`);

    for (const line of SWARM_PRESET_DOCTRINE) expect(types).toContain(line);
  });

  test('the same action set renders byte-identically whatever built the deps', () => {
    // One literal per action, so the cf and node declarations must not differ by a byte.
    const a = createAgentsCodemodeProvider(() => withBuildMode({ swarm: swarmDeps() })).types;

    const b = createAgentsCodemodeProvider(() => withBuildMode({
      swarm: {
        rt: createTestRuntime().rt, model: new MockLanguageModelV3(),
        // Reads the declaration and runs nothing, so no seat is asked for.
        hostNode: refuseHostNode('this case renders declarations and runs no node'),
      },
    })).types;

    expect(a).toBe(b);
  });

  test('members are declared in the canonical ladder order', () => {
    const types = createAgentsCodemodeProvider(fullDeps).types ?? '';
    const order = [...types.matchAll(/^ {2}(\w+)\(input/gm)].map((m) => m[1]);
    expect(order).toEqual([...AGENTS_TOOL_ACTIONS]);
  });

  test('hire declares only the routes and requirements the native actor wires', () => {
    const hireType = (types: string): string => {
      const start = types.indexOf('hire(input:');
      const end = types.indexOf('msg(input:', start);

      return types.slice(start, end);
    };

    const teamOnly = hireType(createAgentsCodemodeProvider(
      () => withBuildMode({ team: makeTeam().deps }),
    ).types ?? '');

    expect(teamOnly).toContain('role: string;');
    expect(teamOnly).toContain('mission: string;');
    expect(teamOnly).not.toContain('scope');
    // `message` reaches this actor only on the existing-agent variant.
    expect(teamOnly).toContain('agent: string;');

    const peersOnly = hireType(createAgentsCodemodeProvider(
      () => withBuildMode({ peers: makePeers().deps }),
    ).types ?? '');

    expect(peersOnly).not.toContain('role');
    expect(peersOnly).not.toContain('tier');
    expect(peersOnly).not.toContain('lifetime');
    expect(peersOnly).toContain('mission: string;');
    expect(peersOnly).toContain('scope: "workspace";');
    expect(peersOnly).toContain('message: string;');

    const both = hireType(createAgentsCodemodeProvider(fullDeps).types ?? '');
    expect(both).toContain('scope?: "subordinate";');
    expect(both).toContain('scope: "workspace";');
    expect(both).not.toContain('role?: string;');
    expect(both).toContain('message: string;');
  });
});

describe('agents surface — one action-field source', () => {
  test('every codemode member declares EXACTLY its action’s fields, in order', () => {
    const types = createAgentsCodemodeProvider(fullDeps).types ?? '';

    for (const action of AGENTS_TOOL_ACTIONS) {
      const body = types.slice(types.indexOf(`${action}(input:`));
      const open = body.indexOf('{');
      const close = body.indexOf('})', open);

      const memberFields = [...new Set(
        [...body.slice(open, close).matchAll(/^\s{4}(\w+)/gm)].map((m) => m[1]),
      )];

      expect(memberFields).toEqual([...agentsActionFieldsFor(fullDeps(), action)]);
    }
  });

  test('the native schema declares the same capability-aware hire variants', () => {
    const hireVariants = (deps: TestAgentsToolDeps) => v.parse(
      ActionVariantSchemaContract,
      createAgentsTool(withBuildMode(deps)).inputSchema,
    ).jsonSchema.oneOf.filter(variant => variant.properties.action.const === 'hire');

    const teamOnly = hireVariants({ team: makeTeam().deps });
    expect(teamOnly).toEqual([{
      properties: { action: { const: 'hire' }, scope: { const: 'subordinate' } },
      required: ['action', 'role', 'mission'],
    }, {
      properties: { action: { const: 'hire' }, scope: false },
      required: ['action', 'agent', 'message'],
    }]);

    const peersOnly = hireVariants({ peers: makePeers().deps });
    expect(peersOnly).toEqual([{
      properties: { action: { const: 'hire' }, scope: false },
      required: ['action', 'agent', 'message'],
    }, {
      properties: { action: { const: 'hire' }, scope: { const: 'workspace' } },
      required: ['action', 'mission', 'scope', 'message'],
    }]);

    // The existing-agent variant is one branch, not one per transport, so the union carries it once.
    expect(hireVariants(fullDeps())).toEqual([teamOnly[0], teamOnly[1], peersOnly[1]]);
  });

  test('native and codemode hide fields whose transport is not wired', () => {
    const advertised = (deps: TestAgentsToolDeps) => new Set(Object.keys(v.parse(
      ToolSchemaContract,
      createAgentsTool(withBuildMode(deps)).inputSchema,
    ).jsonSchema.properties));

    const teamOnly = advertised({ team: makeTeam().deps });

    for (const field of ['scope', 'topic', 'event_id']) expect(teamOnly.has(field)).toBe(false);

    for (const field of ['role', 'tier', 'deliverable', 'lifetime', 'keep_history']) {
      expect(teamOnly.has(field)).toBe(true);
    }

    const peersOnly = advertised({ peers: makePeers().deps });

    for (const field of ['role', 'tier', 'deliverable', 'lifetime', 'keep_history']) {
      expect(peersOnly.has(field)).toBe(false);
    }

    for (const field of ['scope', 'topic', 'event_id']) expect(peersOnly.has(field)).toBe(true);
  });

  test('every dependency combination projects one native and codemode contract', () => {
    const combinations: TestAgentsToolDeps[] = [
      { swarm: swarmDeps() },
      { team: makeTeam().deps },
      { peers: makePeers().deps },
      { team: makeTeam().deps, peers: makePeers().deps },
      fullDeps(),
    ];

    for (const deps of combinations) {
      const resolved = withBuildMode(deps);
      const actions = agentsActionsFor(resolved);
      const types = createAgentsCodemodeProvider(() => resolved).types ?? '';
      const native = v.parse(ActionVariantSchemaContract, createAgentsTool(resolved).inputSchema);

      const advertised = new Set(Object.keys(v.parse(
        ToolSchemaContract,
        createAgentsTool(resolved).inputSchema,
      ).jsonSchema.properties));

      const expectedAdvertised = new Set([
        'action',
        ...actions.flatMap(action => [...agentsActionFieldsFor(resolved, action)]),
      ]);

      expect(advertised).toEqual(expectedAdvertised);

      for (const [at, action] of actions.entries()) {
        const start = types.indexOf(`${action}(input:`);
        const next = actions[at + 1];
        const end = next === undefined ? types.indexOf('};', start) : types.indexOf(`${next}(input:`, start);

        const memberFields = new Set(
          [...types.slice(start, end).matchAll(/^\s{4}(\w+)/gm)].map(match => match[1]),
        );

        expect(memberFields).toEqual(new Set(agentsActionFieldsFor(resolved, action)));

        const actualVariants = native.jsonSchema.oneOf
          .filter(variant => variant.properties.action.const === action);

        const expectedVariants = agentsActionInputVariantsFor(resolved, action);
        expect(actualVariants.map(variant =>
          variant.properties.scope === false ? false : variant.properties.scope.const))
          .toEqual(expectedVariants.map(variant => variant.scope ?? false));
        expect(actualVariants.map(variant => variant.required.slice(1)))
          .toEqual(expectedVariants.map(variant => [...variant.required]));
      }
    }
  });

  test('the swarm member carries `name` — the drift that was measured', async () => {
    const types = createAgentsCodemodeProvider(fullDeps).types ?? '';
    const swarm = types.slice(types.indexOf('swarm(input:'), types.indexOf('hire(input:'));
    expect(swarm).toContain('name?: string;');
    expect(swarm).toContain('role?: string;');
    // A tier is any catalog id, so the declaration is open; the schema enum carries the catalog's list per
    // call.
    expect(swarm).toContain('tier?: string;');
  });

  test('the native tool schema advertises the same per-action fields it parses', () => {
    // Read raw: the contract parse narrows to the fields it names.
    const schema = v.parse(
      ToolSchemaContract,
      createAgentsTool(withBuildMode({ swarm: swarmDeps(), team: makeTeam().deps, peers: makePeers().deps })).inputSchema,
    );

    const advertised = new Set(Object.keys(schema.jsonSchema.properties).filter((k) => k !== 'action'));

    for (const action of AGENTS_TOOL_ACTIONS) {
      for (const field of ACTION_FIELDS[action]) expect(advertised.has(field)).toBe(true);
    }

    expect(advertised.has('model')).toBe(false);
    expect(advertised.has('tier')).toBe(true);
  });

  test('a direct model spec is refused on hire and swarm, naming tier instead', () => {
    expect(() => parseAgentsToolInput({ input: { action: 'hire', role: 'researcher', mission: 'm', model: 'openai/gpt' } }))
      .toThrow(/model/);
    expect(() => parseAgentsToolInput({ input: { action: 'swarm', preset: 'ideate', task: 't', model: 'openai/gpt' } }))
      .toThrow(/model/);
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
    }),
    ...overrides,
  };
}

describe('agents delegation — role/tier/preset precedence', () => {
  test('hire resolves an explicit role through the catalog: role default tier, provenance recorded', async () => {
    const team = makeTeam();
    const tools = namespaceOf(() => profileDeps({ team: team.deps }));
    await member(tools, 'hire').execute?.({ role: 'researcher', mission: 'map the landscape' });
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
    await member(tools, 'hire').execute?.({ role: 'planner', mission: 'plan', tier: 'deep' });

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
      }),
    });

    const tools2 = namespaceOf(() => restricted);
    const refused = await member(tools2, 'hire').execute?.({ role: 'auditor', mission: 'x' });
    expect(refused).toMatchObject({ reason: 'bad_input' });
    expect(v.parse(ErrorResultSchema, refused).error).toContain('auditor');
  });

  test('a role-homogeneous swarm takes its preset from the role when omitted', async () => {
    // Resolution ran: with the role's default preset, an objective-less ideate run fails at expansion, not at
    // `preset`.
    const deps = profileDeps();
    const tools = namespaceOf(() => deps);
    const noPreset = await member(tools, 'swarm').execute?.({ task: 'explore angles' });
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
    const refused = await member(tools, 'swarm').execute?.({ task: 'angles only' });
    expect(refused).toMatchObject({ reason: 'bad_input' });
    expect(v.parse(ErrorResultSchema, refused).error).toContain('preset');

    const team = makeTeam();
    const noCatalog = namespaceOf(() => ({ swarm: swarmDeps(), team: team.deps }));
    const hireRefused = await member(noCatalog, 'hire').execute?.({ role: 'researcher', mission: 'scan' });
    expect(hireRefused).toMatchObject({ reason: 'denied' });
    expect(team.calls).toEqual([]);
  });

  test('role summaries project into the native schema from the same catalog', () => {
    const rendered = (deps: TestAgentsToolDeps): string =>
      JSON.stringify(createAgentsTool(withBuildMode(deps)).inputSchema);

    const withCatalog = rendered(profileDeps());
    expect(withCatalog).toContain('researcher');
    expect(withCatalog).toContain('preset research');
    // No catalog wired → no summaries, and nothing invented.
    expect(rendered({ swarm: swarmDeps() })).not.toContain('Available roles');
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
  });
});
