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
import { createTestRuntime, createTestStrategy } from '@proteus/test-utils';
import {
  agentsActionsFor, buildBuiltinTools, createAgentsTool, createStrategyRegistry,
  createSingleShotStrategy, renderAgentsToolDescription,
  AGENTS_TOOL_ACTIONS, BUILTIN_TOOL_DESCRIPTIONS, DELEGATION_RUNGS,
  FORK_STRATEGY_ID, PEER_REPLY_TOPIC,
  type AgentsForkDeps, type AgentsToolDeps, type PeersToolDeps,
  type StrategyContext, type SubordinateRosterEntry, type TeamToolDeps,
  type SubordinateDelivery, type SubordinateHandoff,
} from '../src/index.ts';

interface Call { action: string; input: unknown }

type ExecutableTool = {
  execute: (args: Record<string, unknown>, opts?: unknown) => Promise<unknown>;
  description?: string;
  inputSchema: unknown;
};

function agentsTool(deps: AgentsToolDeps): ExecutableTool {
  return createAgentsTool(deps) as unknown as ExecutableTool;
}

function forkDeps(overrides: Partial<AgentsForkDeps> = {}): AgentsForkDeps {
  const reg = createStrategyRegistry();
  reg.register(createTestStrategy({ id: FORK_STRATEGY_ID, answer: 'forked' }));
  reg.register(createTestStrategy({ id: 'mcts', answer: 'searched' }));
  const { rt } = createTestRuntime();
  return { registry: reg, rt, model: rt.llm as never, ...overrides };
}

function actionEnum(t: ExecutableTool): string[] {
  const schema = t.inputSchema as { jsonSchema: { properties: { action: { enum: string[] } } } };
  return schema.jsonSchema.properties.action.enum;
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

function makeTeam(overrides: Partial<TeamToolDeps> = {}): { deps: TeamToolDeps; calls: Call[] } {
  const calls: Call[] = [];
  const deps: TeamToolDeps = {
    list: async () => [rosterEntry],
    spawn: async (input) => {
      calls.push({ action: 'spawn', input });
      return { name: input.name ?? 'researcher', displayName: 'Researcher' };
    },
    assign: async (input) => { calls.push({ action: 'assign', input }); return { ok: true, name: input.name, ...handoff('steering_live_turn', true) }; },
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

function makePeers(overrides: Partial<PeersToolDeps> = {}): { deps: PeersToolDeps; calls: Call[] } {
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
    const deps: AgentsToolDeps = { fork: forkDeps() };
    expect(agentsActionsFor(deps)).toEqual(['fork']);
    const t = agentsTool(deps);
    expect(actionEnum(t)).toEqual(['fork']);
    // The docstring drops the staff rung and the converse verbs entirely.
    expect(t.description).toContain(DELEGATION_RUNGS.fork);
    expect(t.description).not.toContain(DELEGATION_RUNGS.staff);
    expect(t.description).not.toContain('reply answers');
  });

  test('full deps (the workspace orchestrator) expose every action and the registry docstring verbatim', () => {
    const deps: AgentsToolDeps = { fork: forkDeps(), team: makeTeam().deps, peers: makePeers().deps };
    expect(agentsActionsFor(deps)).toEqual([...AGENTS_TOOL_ACTIONS]);
    const t = agentsTool(deps);
    expect(actionEnum(t)).toEqual([...AGENTS_TOOL_ACTIONS]);
    // Full surface = the canonical registry description, no parallel assembly.
    expect(t.description).toBe(BUILTIN_TOOL_DESCRIPTIONS.agents);
  });

  test('team-without-peers gates the peer-only pieces (no reply, no scope, no workspace staffing)', () => {
    const deps: AgentsToolDeps = { team: makeTeam().deps };
    expect(agentsActionsFor(deps)).toEqual(['staff', 'ask', 'send', 'list', 'dismiss']);
    const t = agentsTool(deps);
    expect(actionEnum(t)).not.toContain('reply');
    expect(actionEnum(t)).not.toContain('fork');
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
    const result = await t.execute({ action: 'fork', task: 'x' }) as { strategy: string; text: string };
    expect(result.strategy).toBe(FORK_STRATEGY_ID);
    expect(result.text).toBe('forked');
  });

  test('settle=mcts routes to the EXISTING mcts strategy — the engine is a settle policy, not a rung', async () => {
    const t = agentsTool({ fork: forkDeps() });
    const result = await t.execute({ action: 'fork', task: 'x', settle: 'mcts' }) as { strategy: string; text: string };
    expect(result.strategy).toBe('mcts');
    expect(result.text).toBe('searched');
    // mcts stays fully reachable through the enum the model reads.
    const schema = agentsTool({ fork: forkDeps() }).inputSchema as {
      jsonSchema: { properties: { settle: { enum: string[] } }; required: string[] };
    };
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
    const schema = agentsTool({ fork: forkDeps() }).inputSchema as {
      jsonSchema: { properties: { forks: { items: { properties: { model: { description: string } } } } } };
    };
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
    const schema = agentsTool({ fork: forkDeps() }).inputSchema as {
      jsonSchema: { properties: { merge_strategy: { description: string } } };
    };
    const merge = schema.jsonSchema.properties.merge_strategy.description;
    expect(merge).toMatch(/Default synthesize/);
    expect(merge).toMatch(/best_of takes the strongest fork whole/);
    expect(merge).toMatch(/consensus reports what the forks agreed on/);
    expect(merge).toMatch(/hands back each disagreement as an open question/);
  });

  test('unknown settle id returns a structured error listing what exists', async () => {
    const t = agentsTool({ fork: forkDeps() });
    const result = await t.execute({ action: 'fork', task: 't', settle: 'nonexistent' }) as { error: string };
    expect(result.error).toMatch(/Unknown settle/);
    expect(result.error).toContain('merge');
    expect(result.error).toContain('mcts');
  });

  test('non-advertised strategies stay dispatchable by settle id (eval harness path)', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: FORK_STRATEGY_ID, answer: 'forked' }));
    reg.register({ ...createTestStrategy({ id: 'baseline', answer: 'from baseline' }), advertised: false });
    const { rt } = createTestRuntime();
    const t = agentsTool({ fork: { registry: reg, rt, model: rt.llm as never } });
    const result = await t.execute({ action: 'fork', task: 'x', settle: 'baseline' }) as { strategy: string; text: string };
    expect(result.strategy).toBe('baseline');
    expect(result.text).toBe('from baseline');
  });

  test('strategy throws surface as {error}, never into the turn', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: FORK_STRATEGY_ID, throwError: 'kaboom' }));
    const { rt } = createTestRuntime();
    const t = agentsTool({ fork: { registry: reg, rt, model: rt.llm as never } });
    const result = await t.execute({ action: 'fork', task: 't' }) as { error: string };
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
        registry: reg, rt, model: rt.llm as never,
        defaultOptions: () => ({ mcts: { iterations: 7 }, heads: { controller, count: 3 } }),
      },
    });
    await t.execute({ action: 'fork', task: 't', options: { heads: { count: 5 } } });
    // Untouched strategy bag passes through verbatim.
    expect(observedOpts?.mcts).toEqual({ iterations: 7 });
    // One-level deep merge: caller's `count` overrides, but the host-injected
    // `controller` is NOT clobbered. This is the bug the shallow spread had.
    expect(observedOpts?.heads).toEqual({ controller, count: 5 });
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
      fork: { registry: reg, rt, model: rt.llm as never, defaultOptions: () => ({ heads: { controller } }) },
    });
    const specs = [
      { task: 'survey prior art', rationale: 'establish baseline' },
      { task: 'sketch design', rationale: 'exercise constraints' },
    ];
    await t.execute({ action: 'fork', task: 't', forks: specs, merge_strategy: 'consensus' });
    // Injected controller + LLM-supplied specs coexist under options.heads.
    expect(observedOpts?.heads).toEqual({ controller, heads: specs, mergeStrategy: 'consensus' });
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
    const t = agentsTool({ fork: { registry: reg, rt, model: rt.llm as never } });
    await t.execute({ action: 'fork', task: 't', budget: 42, wall_clock_ms: 999 });
    expect(observedBudget?.maxIterations).toBe(42);
    expect(observedBudget?.wallClockMs).toBe(999);
  });

  test('the settle enum advertises mcts only when the strategy is registered', () => {
    const reg = createStrategyRegistry();
    reg.register(createSingleShotStrategy());   // advertised: false (eval baseline)
    reg.register(createTestStrategy({ id: FORK_STRATEGY_ID }));
    const { rt } = createTestRuntime();
    const t = agentsTool({ fork: { registry: reg, rt, model: rt.llm as never } });
    const schema = t.inputSchema as { jsonSchema: { properties: { settle?: unknown } } };
    expect(schema.jsonSchema.properties.settle).toBeUndefined();
    expect(t.description).not.toContain('single-shot');
  });
});

// ── staff / ask / send — subordinates ───────────────────────────────────────

describe('agents tool — subordinate actions', () => {
  test('staff forwards role/mission (+ optional agent name/model) to team.spawn', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({
      action: 'staff', role: 'researcher', mission: 'Map the landscape', model: 'openai/gpt-5',
    });
    expect(result).toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(calls[0].input).toEqual({ role: 'researcher', mission: 'Map the landscape', model: 'openai/gpt-5' });
  });

  test('ask to a roster name assigns the work and says the report arrives as an event', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({
      action: 'ask', agent: 'researcher', message: 'Survey auth', deliverable: 'a note', deadline_hint: 'today',
    }) as { status: string; agent: string; note: string };
    expect(result.status).toBe('working');
    expect(result.agent).toBe('researcher');
    expect(result.note).toContain('event');
    expect(calls[0]).toEqual({
      action: 'assign',
      input: { name: 'researcher', task: 'Survey auth', deliverable: 'a note', deadlineHint: 'today' },
    });
  });

  // The sender used to be told a fixed sentence and nothing else: no id to
  // correlate the eventual report with, and no way to know whether the
  // subordinate was mid-work. Both are things admission already knew.
  test('ask reports the event id, how the work lands, and what the subordinate was doing', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = await t.execute({ action: 'ask', agent: 'researcher', message: 'Survey auth' }) as {
      event_id: string; delivery: string; subordinate_phase: { busy: boolean; workingOn: string | null }; note: string;
    };

    expect(result.event_id).toBe('evt-steering_live_turn');
    expect(result.delivery).toBe('steering_live_turn');
    expect(result.subordinate_phase).toEqual({ busy: true, lastActivityAt: 1234, workingOn: 'reading src/auth.ts' });
    // The note has to teach the model that a busy subordinate is steered, not
    // blocked — that is what changes how it delegates.
    expect(result.note).toContain('mid-turn');
    expect(result.note).toContain('evt-steering_live_turn');
  });

  test('ask against an idle subordinate says the work starts now', async () => {
    const { deps } = makeTeam({
      assign: async (input) => ({ ok: true, name: input.name, ...handoff('starts_now', false) }),
    });
    const t = agentsTool({ team: deps });

    const result = await t.execute({ action: 'ask', agent: 'researcher', message: 'x' }) as { delivery: string; note: string };

    expect(result.delivery).toBe('starts_now');
    expect(result.note).toContain('idle');
  });

  test('ask deduped against work already waiting says so instead of claiming a fresh start', async () => {
    const { deps } = makeTeam({
      assign: async (input) => ({ ok: true, name: input.name, ...handoff('queued', true) }),
    });
    const t = agentsTool({ team: deps });

    const result = await t.execute({ action: 'ask', agent: 'researcher', message: 'x' }) as { delivery: string; note: string };

    expect(result.delivery).toBe('queued');
    expect(result.note).toContain('Already waiting');
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
      action: 'message', input: { name: 'researcher', content: 'also check the CLI' },
    });
  });

  test('send uses the same delivered/queued vocabulary as the peer transport', async () => {
    const steered = agentsTool({ team: makeTeam({
      message: async (input) => ({ ok: true, name: input.name, ...handoff('steering_live_turn', true) }),
    }).deps });
    const backlogged = agentsTool({ team: makeTeam({
      message: async (input) => ({ ok: true, name: input.name, ...handoff('queued', true) }),
    }).deps });

    // Spliced into the live turn IS reaching the target's context.
    expect(await steered.execute({ action: 'send', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'delivered', delivery: 'steering_live_turn' });
    expect(await backlogged.execute({ action: 'send', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'queued', delivery: 'queued' });
  });

  test('a COMPLETED (idle) subordinate still answers a follow-up ask — persistence is the semantic', async () => {
    // rosterEntry.status is 'idle' — the state a subordinate lands in after
    // reporting completed. It must remain addressable, not evicted.
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({ action: 'ask', agent: 'researcher', message: 'one more thing' }) as { status: string };
    expect(result.status).toBe('working');
    expect(calls[0].action).toBe('assign');
  });

  test('list returns the unified roster; empty roster hints staff', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });
    expect(await t.execute({ action: 'list' })).toEqual({ subordinates: [rosterEntry] });

    const empty = agentsTool({ team: makeTeam({ list: async () => [] }).deps });
    const emptyResult = await empty.execute({ action: 'list' }) as { subordinates: unknown[]; note?: string };
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
    const result = await t.execute({ action: 'ask', agent: 'researcher', message: 'x' }) as { error: string };
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
    expect(peers.calls[0].input).toMatchObject({ agent: 'scout', topic: 'research', message: 'What changed?' });
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
    expect(calls.map((c) => (c.input as { timeoutMs: number }).timeoutMs)).toEqual([120_000, 5_000, 600_000]);
    expect((calls[0].input as { topic: string }).topic).toBe('message');
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
    const result = await t.execute({
      action: 'send', agent: 'scout', message: 'x', topic: PEER_REPLY_TOPIC,
    }) as { error?: string };
    expect(result.error).toContain('reserved');
    expect(calls).toEqual([]);
  });
});
