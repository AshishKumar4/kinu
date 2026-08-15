// The unified `agents` delegation tool — one surface where the KIND of helper
// is a parameter. Pins the whole tool-side contract:
//   fork    — dispatch through the StrategyRegistry (settle merge → heads,
//             settle mcts → the MCTS strategy), defaultOptions deep-merge,
//             budget passthrough, error envelopes.
//   staff   — subordinate spawn (and scope=workspace → peer spawnWorkspace).
//   ask/send/reply/list/dismiss — one addressing scheme across subordinates
//             and peer workspace agents, timeout clamping, the reserved
//             reply topic, and the PERSISTENCE semantic (dismiss archives by
//             default; completion never evicts).
// The transports themselves (facet substrate, peer outbox, waiters, reply
// channels, head runtime) are exercised in cf-backend tests against the real
// hubs; deps here are recorders.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createTestStrategy, toolExecute } from '@proteus/test-utils';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import {
  agentsActionsFor, buildBuiltinTools, createAgentsTool, createStrategyRegistry,
  createSingleShotStrategy, renderAgentsToolDescription, strategyOption,
  AGENTS_TOOL_ACTIONS, BUILTIN_TOOL_DESCRIPTIONS, DELEGATION_RUNGS,
  FORK_STRATEGY_ID, PEER_REPLY_TOPIC,
  type AgentsToolInput,
  type AgentsForkDeps, type AgentsToolDeps, type PeersToolDeps,
  type StrategyContext, type SubordinateRosterEntry, type TeamToolDeps,
  type SubordinateDelivery, type SubordinateHandoff,
} from '../src/index.ts';

interface Call { action: string; input: object }
type AgentsTestResult = object | string | number | boolean | null | undefined;

type TestAgentsToolDeps = Omit<AgentsToolDeps, 'mode'> & { mode?: AgentsToolDeps['mode'] };

function withBuildMode(deps: TestAgentsToolDeps): AgentsToolDeps {
  return { mode: 'build', ...deps };
}

function agentsTool(deps: TestAgentsToolDeps) {
  const entry = createAgentsTool(withBuildMode(deps));
  if (!entry) throw new Error('Expected agents tool to be created');
  return { ...entry, execute: toolExecute<AgentsToolInput, AgentsTestResult>(entry) };
}

const testModel = new MockLanguageModelV3();
const StrategyResultSchema = v.object({ strategy: v.string(), text: v.string() });
const ErrorResultSchema = v.object({ error: v.string() });
const DeliveryNoteSchema = v.object({ delivery: v.string(), note: v.string() });
const WorkingResultSchema = v.object({ status: v.string(), agent: v.string(), note: v.string() });
const HandoffResultSchema = v.object({
  event_id: v.string(),
  delivery: v.string(),
  subordinate_phase: v.object({
    busy: v.boolean(), lastActivityAt: v.nullable(v.number()), workingOn: v.nullable(v.string()),
  }),
  note: v.string(),
});

function forkDeps(overrides: Partial<AgentsForkDeps> = {}): AgentsForkDeps {
  const reg = createStrategyRegistry();
  reg.register(createTestStrategy({ id: FORK_STRATEGY_ID, answer: 'forked' }));
  reg.register(createTestStrategy({ id: 'mcts', answer: 'searched' }));
  const { rt } = createTestRuntime();
  return { registry: reg, rt, model: testModel, ...overrides };
}

function actionEnum(input: { value: unknown }): string[] {
  return v.parse(v.object({
    jsonSchema: v.object({
      properties: v.object({ action: v.object({ enum: v.array(v.string()) }) }),
    }),
  }), input.value).jsonSchema.properties.action.enum;
}

const rosterEntry: SubordinateRosterEntry = {
  name: 'researcher', displayName: 'Researcher', role: 'competitive research',
  createdBy: 'orchestrator', status: 'idle', currentTask: null,
  createdAt: 1000, dismissedAt: null,
};

const handoff = (delivery: SubordinateDelivery, busy: boolean): SubordinateHandoff => ({
  eventId: `evt-${delivery}`,
  delivery,
  phase: { busy, lastActivityAt: 1234, workingOn: busy ? 'reading src/auth.ts' : null },
});

function makeTeam(overrides: Partial<TeamToolDeps> = {}) {
  const calls: Call[] = [];
  const deps: TeamToolDeps = {
    list: async () => [rosterEntry],
    create: async (input) => ({
      name: input.name ?? 'researcher',
      displayName: 'Researcher',
      subordinate: {
        name: input.name ?? 'researcher', displayName: 'Researcher', role: input.role,
        createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null,
      },
    }),
    spawn: async (input) => {
      calls.push({ action: 'spawn', input });
      return { name: input.name ?? 'researcher', displayName: 'Researcher' };
    },
    assign: async (input) => { calls.push({ action: 'assign', input }); return { ok: true, name: input.name, ...handoff('queued', true) }; },
    status: async (input) => { calls.push({ action: 'status', input }); return { roster: [rosterEntry] }; },
    message: async (input) => { calls.push({ action: 'message', input }); return { ok: true, name: input.name, ...handoff('starts_now', false) }; },
    dismiss: async (input) => {
      calls.push({ action: 'dismiss', input });
      return { ok: true, name: input.name, historyKept: input.keepHistory ?? false };
    },
    ...overrides,
  };
  return { deps, calls };
}

function makePeers(overrides: Partial<PeersToolDeps> = {}) {
  const calls: Call[] = [];
  const deps: PeersToolDeps = {
    listPeers: async () => [{ name: 'scout', displayName: 'Scout' }],
    ask: async (input) => {
      calls.push({ action: 'ask', input });
      return { status: 'replied', from: input.agent, reply: 'answer' };
    },
    send: async (input) => {
      calls.push({ action: 'send', input });
      return { status: 'delivered', message_id: 'ox1' };
    },
    reply: async (input) => {
      calls.push({ action: 'reply', input });
      return { ok: true };
    },
    spawnWorkspace: async (input) => {
      calls.push({ action: 'spawn_workspace', input });
      return { agent: input.name ?? 'specialist', created: true, status: 'replied', from: 'specialist', reply: 'done' };
    },
    ...overrides,
  };
  return { deps, calls };
}

// ── Structural gating ───────────────────────────────────────────────────────

describe('agents tool — registration and dep-gating', () => {
  test('no deps groups → no agents tool at all', () => {
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt });
    expect(Object.keys(tools)).not.toContain('agents');
    expect(Object.keys(tools)).not.toContain('think');
    expect(Object.keys(tools)).not.toContain('team');
    expect(Object.keys(tools)).not.toContain('peers');
  });

  test('fork-only deps (the CLI / subordinate surface) expose only action=fork', () => {
    const deps = withBuildMode({ fork: forkDeps() });
    expect(agentsActionsFor(deps)).toEqual(['fork']);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).toEqual(['fork']);
    // The docstring drops the staff rung and the converse verbs entirely.
    expect(t.description).toContain(DELEGATION_RUNGS.fork);
    expect(t.description).not.toContain(DELEGATION_RUNGS.staff);
    expect(t.description).not.toContain('reply answers');
  });

  test('full deps (the workspace orchestrator) expose every action and the registry docstring verbatim', () => {
    const deps = withBuildMode({ fork: forkDeps(), team: makeTeam().deps, peers: makePeers().deps });
    expect(agentsActionsFor(deps)).toEqual([...AGENTS_TOOL_ACTIONS]);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).toEqual([...AGENTS_TOOL_ACTIONS]);
    // Full surface = the canonical registry description, no parallel assembly.
    expect(t.description).toBe(BUILTIN_TOOL_DESCRIPTIONS.agents);
  });

  test('team-without-peers gates the peer-only pieces (no reply, no scope, no workspace staffing)', () => {
    const deps = withBuildMode({ team: makeTeam().deps });
    expect(agentsActionsFor(deps)).toEqual(['staff', 'ask', 'send', 'list', 'dismiss']);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).not.toContain('reply');
    expect(actionEnum({ value: t.inputSchema })).not.toContain('fork');
    expect(renderAgentsToolDescription(deps)).not.toContain('scope=workspace');
  });

  test('an unavailable action is a sharp error, not a deps call', async () => {
    const t = agentsTool({ fork: forkDeps() });
    expect(await t.execute({ action: 'staff', role: 'r', mission: 'm' }))
      .toEqual({ error: 'action "staff" is not available here. Available: fork' });
  });
});

// ── fork — strategy dispatch (the former think tool, semantics preserved) ───

describe('agents tool — fork dispatch', () => {
  test('fork with settle unset routes to the heads (fork) strategy', async () => {
    const t = agentsTool({ fork: forkDeps() });
    const result = v.parse(StrategyResultSchema, await t.execute({ action: 'fork', task: 'x' }));
    expect(result.strategy).toBe(FORK_STRATEGY_ID);
    expect(result.text).toBe('forked');
  });

  test('settle=mcts routes to the EXISTING mcts strategy — the engine is a settle policy, not a rung', async () => {
    const t = agentsTool({ fork: forkDeps() });
    const result = v.parse(
      StrategyResultSchema,
      await t.execute({ action: 'fork', task: 'x', settle: 'mcts' }),
    );
    expect(result.strategy).toBe('mcts');
    expect(result.text).toBe('searched');
    // mcts stays fully reachable through the enum the model reads.
    const schema = v.parse(v.object({ jsonSchema: v.object({
      properties: v.object({ settle: v.object({ enum: v.array(v.string()) }) }),
      required: v.array(v.string()),
    }) }), agentsTool({ fork: forkDeps() }).inputSchema);
    expect(schema.jsonSchema.properties.settle.enum).toEqual(['merge', 'mcts']);
    expect(schema.jsonSchema.required).toEqual(['action']);
  });

  test('the per-fork model field says what varying it is FOR, and states its cost', async () => {
    // Heterogeneous fleets are first-class (heads/controller.ts threads the
    // per-head model over the parent default), but the field only documented
    // its syntax, so a real capability read as a knob. The purpose belongs
    // here rather than in the prompt — it is a fill-time decision — and it
    // carries the Self-MoA result (arXiv 2502.00674: panel quality tracks the
    // AVERAGE member) so "put different models on it" does not read as free.
    const schema = v.parse(v.object({ jsonSchema: v.object({ properties: v.object({
      forks: v.object({ items: v.object({ properties: v.object({
        model: v.object({ description: v.string() }),
      }) }) }),
    }) }) }), agentsTool({ fork: forkDeps() }).inputSchema);
    const model = schema.jsonSchema.properties.forks.items.properties.model.description;
    expect(model).toContain('Omit to inherit');
    expect(model).toMatch(/different vendor on a genuinely open question/);
    expect(model).toMatch(/only as good as its average member/);
  });

  test('each merge_strategy says what it DOES, not just that it exists', async () => {
    // The enum offered three names and one word of guidance ("Default
    // synthesize"), so picking between them was a guess. What each one does
    // was written down only in buildMergePrompt, addressed to the merge model
    // rather than to the caller choosing.
    const schema = v.parse(v.object({ jsonSchema: v.object({ properties: v.object({
      merge_strategy: v.object({ description: v.string() }),
    }) }) }), agentsTool({ fork: forkDeps() }).inputSchema);
    const merge = schema.jsonSchema.properties.merge_strategy.description;
    expect(merge).toMatch(/Default synthesize/);
    expect(merge).toMatch(/best_of takes the strongest fork whole/);
    expect(merge).toMatch(/consensus reports what the forks agreed on/);
    expect(merge).toMatch(/hands back each disagreement as an open question/);
  });

  test('unknown settle id returns a structured error listing what exists', async () => {
    const t = agentsTool({ fork: forkDeps() });
    const result = v.parse(
      ErrorResultSchema,
      await t.execute({ action: 'fork', task: 't', settle: 'nonexistent' }),
    );
    expect(result.error).toMatch(/Unknown settle/);
    expect(result.error).toContain('merge');
    expect(result.error).toContain('mcts');
  });

  test('non-advertised strategies stay dispatchable by settle id (eval harness path)', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: FORK_STRATEGY_ID, answer: 'forked' }));
    reg.register({ ...createTestStrategy({ id: 'baseline', answer: 'from baseline' }), advertised: false });
    const { rt } = createTestRuntime();
    const t = agentsTool({ fork: { registry: reg, rt, model: testModel } });
    const result = v.parse(
      StrategyResultSchema,
      await t.execute({ action: 'fork', task: 'x', settle: 'baseline' }),
    );
    expect(result.strategy).toBe('baseline');
    expect(result.text).toBe('from baseline');
  });

  test('strategy throws surface as {error}, never into the turn', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: FORK_STRATEGY_ID, throwError: 'kaboom' }));
    const { rt } = createTestRuntime();
    const t = agentsTool({ fork: { registry: reg, rt, model: testModel } });
    const result = v.parse(ErrorResultSchema, await t.execute({ action: 'fork', task: 't' }));
    expect(result.error).toMatch(/Fork \(settle=merge\) failed/);
    expect(result.error).toMatch(/kaboom/);
  });

  test('deep-merges caller options under injected infra (host deps survive)', async () => {
    const reg = createStrategyRegistry();
    let observedOpts: StrategyContext['options'] | undefined;
    reg.register({
      id: FORK_STRATEGY_ID,
      async explore(ctx) {
        observedOpts = ctx.options;
        return { strategy: FORK_STRATEGY_ID, best: { text: '', score: 1, source: '' }, all: [], cost: { durationMs: 0 } };
      },
    });
    const { rt } = createTestRuntime();
    const controller = { __infra: true };
    const t = agentsTool({
      fork: {
        registry: reg, rt, model: testModel,
        defaultOptions: () => ({ mcts: { iterations: 7 }, heads: { controller, count: 3 } }),
      },
    });
    await t.execute({ action: 'fork', task: 't', options: { heads: { count: 5 } } });
    // Untouched strategy bag passes through verbatim.
    expect(strategyOption(observedOpts, 'mcts')).toEqual({ iterations: 7 });
    // One-level deep merge: caller's `count` overrides, but the host-injected
    // `controller` is NOT clobbered. This is the bug the shallow spread had.
    expect(strategyOption(observedOpts, 'heads')).toEqual({ controller, count: 5 });
  });

  test('folds typed forks / merge_strategy input into options.heads', async () => {
    const reg = createStrategyRegistry();
    let observedOpts: StrategyContext['options'] | undefined;
    reg.register({
      id: FORK_STRATEGY_ID,
      async explore(ctx) {
        observedOpts = ctx.options;
        return { strategy: FORK_STRATEGY_ID, best: { text: '', score: 1, source: '' }, all: [], cost: { durationMs: 0 } };
      },
    });
    const { rt } = createTestRuntime();
    const controller = { __infra: true };
    const t = agentsTool({
      fork: { registry: reg, rt, model: testModel, defaultOptions: () => ({ heads: { controller } }) },
    });
    const specs = [
      { task: 'survey prior art', rationale: 'establish baseline' },
      { task: 'sketch design', rationale: 'exercise constraints' },
    ];
    await t.execute({ action: 'fork', task: 't', forks: specs, merge_strategy: 'consensus' });
    // Injected controller + LLM-supplied specs coexist under options.heads.
    expect(strategyOption(observedOpts, 'heads')).toEqual({ controller, heads: specs, mergeStrategy: 'consensus' });
  });

  test('passes through budget to strategy context', async () => {
    const reg = createStrategyRegistry();
    let observedBudget: StrategyContext['budget'] | undefined;
    reg.register({
      id: FORK_STRATEGY_ID,
      async explore(ctx) {
        observedBudget = ctx.budget;
        return { strategy: FORK_STRATEGY_ID, best: { text: '', score: 1, source: '' }, all: [], cost: { durationMs: 0 } };
      },
    });
    const { rt } = createTestRuntime();
    const t = agentsTool({ fork: { registry: reg, rt, model: testModel } });
    await t.execute({ action: 'fork', task: 't', budget: 42, wall_clock_ms: 999 });
    expect(observedBudget?.maxIterations).toBe(42);
    expect(observedBudget?.wallClockMs).toBe(999);
  });

  test('the settle enum advertises mcts only when the strategy is registered', () => {
    const reg = createStrategyRegistry();
    reg.register(createSingleShotStrategy());   // advertised: false (eval baseline)
    reg.register(createTestStrategy({ id: FORK_STRATEGY_ID }));
    const { rt } = createTestRuntime();
    const t = agentsTool({ fork: { registry: reg, rt, model: testModel } });
    const schema = v.parse(v.object({ jsonSchema: v.object({ properties: v.object({
      settle: v.optional(v.unknown()),
    }) }) }), t.inputSchema);
    expect(schema.jsonSchema.properties.settle).toBeUndefined();
    expect(t.description).not.toContain('single-shot');
  });
});

// ── staff / ask / send — subordinates ───────────────────────────────────────

describe('agents tool — subordinate actions', () => {
  test('the host-stamped Plan mode reaches staff, ask, and send without a model field', async () => {
    const team = makeTeam();
    const tool = agentsTool({ mode: 'plan', team: team.deps });

    await tool.execute({ action: 'staff', role: 'researcher', mission: 'Map without editing' });
    await tool.execute({ action: 'ask', agent: 'researcher', message: 'Inspect the design' });
    await tool.execute({ action: 'send', agent: 'researcher', message: 'Stay read-only' });

    expect(team.calls).toMatchObject([
      { action: 'spawn', input: { mode: 'plan' } },
      { action: 'assign', input: { mode: 'plan' } },
      { action: 'message', input: { mode: 'plan' } },
    ]);
  });

  test('staff forwards role/mission (+ optional agent name/model) to team.spawn', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({
      action: 'staff', role: 'researcher', mission: 'Map the landscape', model: 'openai/gpt-5',
    });
    expect(result).toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(calls[0].input).toEqual({ role: 'researcher', mission: 'Map the landscape', model: 'openai/gpt-5', mode: 'build' });
  });

  test('ask to a roster name assigns the work and says the report arrives as an event', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = v.parse(WorkingResultSchema, await t.execute({
      action: 'ask', agent: 'researcher', message: 'Survey auth', deliverable: 'a note', deadline_hint: 'today',
    }));
    expect(result.status).toBe('working');
    expect(result.agent).toBe('researcher');
    expect(result.note).toContain('event');
    expect(calls[0]).toEqual({
      action: 'assign',
      input: { name: 'researcher', task: 'Survey auth', deliverable: 'a note', deadlineHint: 'today', mode: 'build' },
    });
  });

  // The sender used to be told a fixed sentence and nothing else: no id to
  // correlate the eventual report with, and no way to know whether the
  // subordinate was mid-work. Both are things admission already knew.
  test('ask reports the event id, how the work lands, and what the subordinate was doing', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = v.parse(
      HandoffResultSchema,
      await t.execute({ action: 'ask', agent: 'researcher', message: 'Survey auth' }),
    );

    expect(result.event_id).toBe('evt-queued');
    expect(result.delivery).toBe('queued');
    expect(result.subordinate_phase).toEqual({ busy: true, lastActivityAt: 1234, workingOn: 'reading src/auth.ts' });
    expect(result.note).toContain('own turn');
    expect(result.note).toContain('evt-queued');
  });

  test('ask against an idle subordinate says the work starts now', async () => {
    const { deps } = makeTeam({
      assign: async (input) => ({ ok: true, name: input.name, ...handoff('starts_now', false) }),
    });
    const t = agentsTool({ team: deps });

    const result = v.parse(
      DeliveryNoteSchema,
      await t.execute({ action: 'ask', agent: 'researcher', message: 'x' }),
    );

    expect(result.delivery).toBe('starts_now');
    expect(result.note).toContain('idle');
  });

  test('ask deduped against work already waiting says so instead of claiming a fresh start', async () => {
    const { deps } = makeTeam({
      assign: async (input) => ({ ok: true, name: input.name, ...handoff('queued', true) }),
    });
    const t = agentsTool({ team: deps });

    const result = v.parse(
      DeliveryNoteSchema,
      await t.execute({ action: 'ask', agent: 'researcher', message: 'x' }),
    );

    expect(result.delivery).toBe('queued');
    expect(result.note).toContain('Queued behind');
  });

  test('send to a roster name injects a conversational note', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({ action: 'send', agent: 'researcher', message: 'also check the CLI' });
    expect(result).toEqual({
      status: 'delivered',
      agent: 'researcher',
      event_id: 'evt-starts_now',
      delivery: 'starts_now',
      subordinate_phase: { busy: false, lastActivityAt: 1234, workingOn: null },
    });
    expect(calls[0]).toEqual({
      action: 'message', input: { name: 'researcher', content: 'also check the CLI', mode: 'build' },
    });
  });

  test('send uses the same delivered/queued vocabulary as the peer transport', async () => {
    const delivered = agentsTool({ team: makeTeam({
      message: async (input) => ({ ok: true, name: input.name, ...handoff('starts_now', false) }),
    }).deps });
    const backlogged = agentsTool({ team: makeTeam({
      message: async (input) => ({ ok: true, name: input.name, ...handoff('queued', true) }),
    }).deps });

    expect(await delivered.execute({ action: 'send', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'delivered', delivery: 'starts_now' });
    expect(await backlogged.execute({ action: 'send', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'queued', delivery: 'queued' });
  });

  test('a COMPLETED (idle) subordinate still answers a follow-up ask — persistence is the semantic', async () => {
    // rosterEntry.status is 'idle' — the state a subordinate lands in after
    // reporting completed. It must remain addressable, not evicted.
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = v.parse(
      v.object({ status: v.string() }),
      await t.execute({ action: 'ask', agent: 'researcher', message: 'one more thing' }),
    );
    expect(result.status).toBe('working');
    expect(calls[0].action).toBe('assign');
  });

  test('list returns the unified roster; empty roster hints staff', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });
    expect(await t.execute({ action: 'list' })).toEqual({ subordinates: [rosterEntry] });

    const empty = agentsTool({ team: makeTeam({ list: async () => [] }).deps });
    const emptyResult = v.parse(v.object({
      subordinates: v.array(v.unknown()), note: v.optional(v.string()),
    }), await empty.execute({ action: 'list' }));
    expect(emptyResult.subordinates).toEqual([]);
    expect(emptyResult.note).toContain('staff');
  });

  test('list with a subordinate name returns its live status view', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({ action: 'list', agent: 'researcher' });
    expect(result).toEqual({ roster: [rosterEntry] });
    expect(calls[0]).toEqual({ action: 'status', input: { name: 'researcher' } });
  });

  test('dismiss ARCHIVES by default — context kept unless keep_history is explicitly false', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    expect(await t.execute({ action: 'dismiss', agent: 'researcher' }))
      .toEqual({ ok: true, name: 'researcher', historyKept: true });
    expect(calls[0].input).toEqual({ name: 'researcher', keepHistory: true });
    expect(await t.execute({ action: 'dismiss', agent: 'researcher', keep_history: false }))
      .toEqual({ ok: true, name: 'researcher', historyKept: false });
    expect(calls[1].input).toEqual({ name: 'researcher', keepHistory: false });
  });

  test('missing required args are sharp errors, not deps calls', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    expect(await t.execute({ action: 'staff', role: 'r' })).toEqual({ error: 'staff requires role and mission' });
    expect(await t.execute({ action: 'ask', agent: 'x' })).toEqual({ error: 'ask requires agent and message' });
    expect(await t.execute({ action: 'send', message: 'x' })).toEqual({ error: 'send requires agent and message' });
    expect(await t.execute({ action: 'dismiss' })).toEqual({ error: 'dismiss requires agent' });
    expect(calls).toEqual([]);
  });

  test('deps exceptions surface as tool error objects (never throw into the turn)', async () => {
    const { deps } = makeTeam({
      assign: async () => { throw new Error('subordinate "researcher" is dismissed'); },
    });
    const t = agentsTool({ team: deps });
    const result = v.parse(
      ErrorResultSchema,
      await t.execute({ action: 'ask', agent: 'researcher', message: 'x' }),
    );
    expect(result.error).toContain('dismissed');
  });
});

// ── ask / send / reply / staff scope=workspace — peers ──────────────────────

describe('agents tool — peer workspace actions', () => {
  test('ask to a non-roster name routes to the peer transport and returns the reply', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const t = agentsTool({ team: team.deps, peers: peers.deps });
    const result = await t.execute({ action: 'ask', agent: 'scout', message: 'What changed?', topic: 'research' });
    expect(result).toEqual({ status: 'replied', from: 'scout', reply: 'answer' });
    expect(peers.calls[0].input).toMatchObject({ agent: 'scout', topic: 'research', message: 'What changed?', mode: 'build' });
    expect(team.calls).toEqual([]);   // never touched the subordinate path
  });

  test('a subordinate name wins an addressing collision with a peer', async () => {
    const team = makeTeam();
    const peers = makePeers({ listPeers: async () => [{ name: 'researcher' }] });
    const t = agentsTool({ team: team.deps, peers: peers.deps });
    await t.execute({ action: 'ask', agent: 'researcher', message: 'x' });
    expect(team.calls[0]?.action).toBe('assign');
    expect(peers.calls).toEqual([]);
  });

  test('peer ask defaults: topic "message", timeout 120s; clamp to [5s, 600s]', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x' });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 1 });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 9999 });
    const peerInputs = calls.map((call) => v.parse(v.object({
      timeoutMs: v.number(), topic: v.string(),
    }), call.input));
    expect(peerInputs.map((input) => input.timeoutMs)).toEqual([120_000, 5_000, 600_000]);
    expect(peerInputs[0]?.topic).toBe('message');
  });

  test('send is fire-and-forget; reply forwards the event id', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    expect(await t.execute({ action: 'send', agent: 'scout', message: 'FYI' }))
      .toEqual({ status: 'delivered', message_id: 'ox1' });
    expect(await t.execute({ action: 'reply', event_id: 'pe1', message: 'here you go' })).toEqual({ ok: true });
    expect(calls[1].input).toEqual({ eventId: 'pe1', message: 'here you go' });
  });

  test('staff scope=workspace forwards mission as purpose + message (the old spawn_workspace, verbatim transport)', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    const result = await t.execute({
      action: 'staff', scope: 'workspace', mission: 'summarize research papers', message: 'Summarize X',
    });
    expect(result).toMatchObject({ agent: 'specialist', created: true, status: 'replied' });
    expect(calls[0].input).toMatchObject({
      purpose: 'summarize research papers', message: 'Summarize X', timeoutMs: 120_000,
      mode: 'build',
    });
  });

  test('list merges subordinates and peers into one roster', async () => {
    const t = agentsTool({ team: makeTeam().deps, peers: makePeers().deps });
    expect(await t.execute({ action: 'list' })).toEqual({
      subordinates: [rosterEntry],
      peers: [{ name: 'scout', displayName: 'Scout' }],
    });
  });

  test('missing required args are sharp errors, not deps calls', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    expect(await t.execute({ action: 'ask', agent: 'scout' })).toEqual({ error: 'ask requires agent and message' });
    expect(await t.execute({ action: 'send', message: 'x' })).toEqual({ error: 'send requires agent and message' });
    expect(await t.execute({ action: 'reply', message: 'x' })).toEqual({ error: 'reply requires event_id and message' });
    expect(await t.execute({ action: 'staff', scope: 'workspace', message: 'x' }))
      .toEqual({ error: 'staff scope=workspace requires mission and message' });
    expect(calls).toEqual([]);
  });

  test(`the reserved "${PEER_REPLY_TOPIC}" topic is rejected`, async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    const result = v.parse(v.object({ error: v.optional(v.string()) }), await t.execute({
      action: 'send', agent: 'scout', message: 'x', topic: PEER_REPLY_TOPIC,
    }));
    expect(result.error).toContain('reserved');
    expect(calls).toEqual([]);
  });
});
