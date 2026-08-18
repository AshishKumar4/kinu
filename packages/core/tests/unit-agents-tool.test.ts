// The unified `agents` delegation tool — one surface where the KIND of helper
// is a parameter. Pins the whole tool-side contract:
//   fork    — dispatch through the StrategyRegistry (settle merge → heads,
//             settle mcts → the MCTS strategy), defaultOptions deep-merge,
//             budget passthrough, error envelopes.
//   hire    — subordinate spawn (and scope=workspace → peer spawnWorkspace).
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
import { AGENTS_ACTION_FIELDS } from '../src/tools/agents-tool';
import {
  agentsActionsFor, buildBuiltinTools, createAgentsTool, createStrategyRegistry,
  createSingleShotStrategy, renderAgentsToolDescription, resumableForkInput, strategyOption,
  AGENTS_TOOL_ACTIONS, BUILTIN_TOOL_DESCRIPTIONS, DELEGATION_INHERITANCE, DELEGATION_RUNGS,
  delegationBudgetAtDepth, ROOT_DELEGATION_BUDGET,
  FORK_STRATEGY_ID, PEER_REPLY_TOPIC, SPAWN_STARTED_OPTION,
  classifyToolFailure, JsonObjectSchema,
  type AgentsToolInput,
  type AgentsForkDeps, type AgentsToolDeps, type PeersToolDeps,
  type StrategyContext, type SubordinateRosterEntry, type TeamToolDeps,
  type SubordinateDelivery, type SubordinateHandoff,
} from '../src/index';
import { CODE_IS_REFUSAL, ERROR_CODES } from '../src/obs/index';

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
/** The minimum a merge fork takes. settle=merge refuses a call that supplies no
 *  briefs, so every merge-path test states them. */
const twoForks = [
  { task: 'survey prior art', rationale: 'establish baseline' },
  { task: 'sketch design', rationale: 'exercise constraints' },
];
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

/** The action enum's own description — where the ladder's per-actor facts ride
 *  (which verbs exist, and how much delegation depth is left). */
function actionDescription(input: { value: unknown }): string {
  return v.parse(v.object({
    jsonSchema: v.object({
      properties: v.object({ action: v.object({ description: v.string() }) }),
    }),
  }), input.value).jsonSchema.properties.action.description;
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
    delegation: ROOT_DELEGATION_BUDGET,
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
    // The docstring drops the hire rung and the converse verbs entirely.
    expect(t.description).toContain(DELEGATION_RUNGS.fork);
    expect(t.description).not.toContain(DELEGATION_RUNGS.hire);
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

  test('team-without-peers gates the peer-only pieces (no reply, no scope, no workspace hiring)', () => {
    const deps = withBuildMode({ team: makeTeam().deps });
    expect(agentsActionsFor(deps)).toEqual(['hire', 'ask', 'send', 'list', 'dismiss']);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).not.toContain('reply');
    expect(actionEnum({ value: t.inputSchema })).not.toContain('fork');
    expect(renderAgentsToolDescription(deps)).not.toContain('scope=workspace');
  });

  test('an unavailable action is a sharp error, not a deps call', async () => {
    const t = agentsTool({ fork: forkDeps() });
    expect(await t.execute({ action: 'hire', role: 'r', mission: 'm' }))
      .toEqual({
        reason: 'unsupported',
        error: 'action "hire" is not available here. Available: fork',
      });
  });
});

// ── the field contract, at the surface the model actually calls ─────────────
// The parse used to be a flat `v.object`, which EXCLUDES an unknown entry rather
// than rejecting it, and the native tool did not parse at all: a field the model
// misspelled reached the dispatcher and was read by nothing. On a surface whose
// fields include spend caps, that is a ceiling asked for and never applied.

describe('agents tool — the field contract', () => {
  const fullDeps = () => withBuildMode({ fork: forkDeps(), team: makeTeam().deps, peers: makePeers().deps });

  /** Every property the model is offered, for the actor these deps describe. */
  function propertyNames(input: { value: unknown }): string[] {
    return Object.keys(v.parse(v.object({
      jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }),
    }), input.value).jsonSchema.properties);
  }

  test('a camelCase cap is refused by the tool, naming the field it meant', async () => {
    const t = agentsTool({ fork: forkDeps() });
    /* SAFETY: a field `AgentsToolInput` does not declare, which is precisely what
       reaches `execute` in production — the AI SDK validates a tool call's TYPES
       against the JSON Schema and never its field NAMES. */
    const refusal = v.parse(v.object({ reason: v.string(), error: v.string() }), await t.execute({
      action: 'fork', task: 'explore', budgetUsd: 5, wallClockMs: 1_000,
    } as AgentsToolInput));
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('unknown field "budgetUsd" — did you mean "budget_usd"?');
    expect(refusal.error).toContain('unknown field "wallClockMs" — did you mean "wall_clock_ms"?');
  });

  test('the refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    // Same vocabulary read-models/tool-failures.ts classifies. A parse refusal
    // is the caller's spelling, so it must land in `refused` rather than
    // indicting the tool in `broke` — otherwise closing one silence buys a
    // false defect rate in the ledger.
    const args = { action: 'fork', task: 'explore', budgetUsd: 5 };
    /* SAFETY: the mis-spelled field is the subject of the test. Every field name
       is validated by `execute` before any field is read, so this object is
       refused rather than acted on. */
    const result = await agentsTool({ fork: forkDeps() }).execute(args as AgentsToolInput);
    expect(classifyToolFailure({
      type: 'tool_call_end', eventIndex: 0, runId: 'run-1',
      timestamp: new Date().toISOString(), name: 'agents', toolCallId: 'tc-1',
      args: v.parse(JsonObjectSchema, args), result: v.parse(JsonObjectSchema, result),
    })).toEqual({
      tool: 'agents', action: 'fork', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('the correctly spelled call still runs — the refusal is about names, not caps', async () => {
    // The control. Without it the refusal above could be a tool that refuses
    // every fork with a budget.
    const t = agentsTool({ fork: forkDeps() });
    const result = v.parse(StrategyResultSchema, await t.execute({
      action: 'fork', task: 'explore', forks: twoForks, budget_usd: 5, wall_clock_ms: 1_000,
    }));
    expect(result.strategy).toBe(FORK_STRATEGY_ID);
  });

  test('a cap on an action that cannot spend it is refused, not accepted and ignored', async () => {
    // `budget_usd` is real, and only `fork` reads it: the host meters an
    // exploration it owns, while a subordinate runs on its own storage and is
    // gated at the spawn seam instead. Sent to `hire` it parsed cleanly and was
    // then read by nothing at all, which is the same silence one layer in.
    const team = makeTeam();
    const t = agentsTool({ team: team.deps });
    const refusal = v.parse(ErrorResultSchema, await t.execute({
      action: 'hire', role: 'researcher', mission: 'survey the landscape', budget_usd: 5,
    }));
    expect(refusal.error).toContain('field "budget_usd" does not apply to action "hire"');
    expect(refusal.error).toContain('it is read by fork');
    expect(refusal.error).toContain('action "hire" takes: agent, role, mission');
    // Refused BEFORE the spawn, so nothing was hired under a cap nothing holds.
    expect(team.calls).toEqual([]);
  });

  test('a misspelled field inside a fork brief is refused too, in the brief\'s own convention', async () => {
    // The one place this surface is camelCase, and therefore the one place the
    // collision is native rather than imported.
    const t = agentsTool({ fork: forkDeps() });
    const call = {
      action: 'fork',
      task: 'explore',
      forks: [{ task: 'a', rationale: 'b', allowed_tools: ['run'] }],
    };
    /* SAFETY: a deliberately mis-shaped input one level down — a brief's fields
       are camelCase and `allowed_tools` is not one of them. Every field name is
       validated by `execute` before any field is read, so this object is refused
       rather than acted on. */
    const refusal = v.parse(ErrorResultSchema, await t.execute(call as AgentsToolInput));
    expect(refusal.error).toContain('unknown field "forks[0].allowed_tools" — did you mean "allowedTools"?');
  });

  test('every advertised property is a field some action reads, and every field is advertised', () => {
    // The advertised-vs-parsed half of what `gate:agents-fields` holds from the
    // declaration side. Under FULL deps, because the property set is
    // dep-gated: what an actor is offered is a subset, and the union is what
    // must agree with the map.
    const advertised = propertyNames({ value: agentsTool(fullDeps()).inputSchema }).sort();
    const claimed = [...new Set(AGENTS_TOOL_ACTIONS.flatMap((action) => [...AGENTS_ACTION_FIELDS[action]]))];
    expect(advertised).toEqual(['action', ...claimed].sort());
  });

  test('a dep-gated actor advertises a subset, and never a field no action of its own reads', () => {
    // Non-vacuity for the assertion above: it must be comparing something that
    // can differ. A fork-only actor is offered fork's fields and nothing else.
    const forkOnly = propertyNames({ value: agentsTool({ fork: forkDeps() }).inputSchema }).sort();
    expect(forkOnly).toEqual(['action', ...AGENTS_ACTION_FIELDS.fork].sort());
  });
});

// ── the delegation depth cap, at the seam ───────────────────────────────────
// The cap's PRIMARY mechanism is absence: an actor at it is wired no `team`
// deps, so `hire` is not in the enum (see the surface tests above, and
// cf-backend's teamProfile()). These cover the seam — the window absence cannot
// reach, since a ToolSet is cached across turns and a facet's identity is seeded
// after it is built.

describe('agents tool — delegation depth', () => {
  const depthDeps = (depth: number, extra: Partial<AgentsToolDeps> = {}) => {
    const team = makeTeam();
    return {
      team,
      deps: withBuildMode({ team: { ...team.deps, delegation: delegationBudgetAtDepth(depth) }, ...extra }),
    };
  };

  test('depth 4 is reachable and depth 5 is refused, at the boundary', async () => {
    // Room left below depth 3, so this hire PRODUCES the depth-4 subordinate.
    const below = depthDeps(3);
    expect(await agentsTool(below.deps).execute({ action: 'hire', role: 'r', mission: 'm' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(below.team.calls).toMatchObject([{ action: 'spawn' }]);

    // Depth 4 is the deepest that exists; the hire it would make is depth 5.
    const atCap = depthDeps(4);
    const refusal = await agentsTool(atCap.deps).execute({ action: 'hire', role: 'r', mission: 'm' });
    expect(refusal).toEqual({ reason: 'denied', error: expect.stringContaining('depth 4') });
    expect(refusal).toMatchObject({ error: expect.stringContaining('depth 5') });
    // Refused BEFORE the substrate: nothing was spawned, so a refusal cannot
    // leave a half-made subordinate behind.
    expect(atCap.team.calls).toEqual([]);
  });

  test('the refusal lands in refused, not in broke', async () => {
    const { deps } = depthDeps(4);
    const refusal = v.parse(
      v.object({ reason: v.picklist([...ERROR_CODES]), error: v.string() }),
      await agentsTool(deps).execute({ action: 'hire', role: 'r', mission: 'm' }),
    );
    expect(CODE_IS_REFUSAL[refusal.reason]).toBe(true);
  });

  // The escape the cap has to close: a WORKSPACE is the root of its own tree
  // with the whole cap below it, so an actor that could mint one would reset its
  // own depth to 0. It is closed structurally — `peers` is never wired below the
  // orchestrator — and the refusal says so rather than reading as a defect.
  test('a subordinate cannot mint a fresh root to escape its own subtree', async () => {
    const { deps, team } = depthDeps(2);
    const refusal = await agentsTool(deps).execute({
      action: 'hire', scope: 'workspace', mission: 'a tree of my own', message: 'go',
    });
    expect(refusal).toMatchObject({ reason: 'denied' });
    expect(refusal).toMatchObject({ error: expect.stringContaining('only the workspace orchestrator') });
    expect(team.calls).toEqual([]);
    // …and the roster path stays open: the point is that it cannot leave its
    // subtree, not that it cannot delegate.
    expect(await agentsTool(deps).execute({ action: 'hire', role: 'r', mission: 'm' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
  });

  test('the remaining depth is advertised where head-tools advertises nesting room', () => {
    expect(agentsTool(depthDeps(0).deps).description).toBeTruthy();
    const enumDescription = (depth: number) => actionDescription({ value: agentsTool(depthDeps(depth).deps).inputSchema });
    expect(enumDescription(0)).toContain('3 level(s) further');
    expect(enumDescription(3)).toContain('lands on the depth cap and cannot hire its own');
  });
});

// ── fork — strategy dispatch (the former think tool, semantics preserved) ───

describe('agents tool — fork dispatch', () => {
  test('fork with settle unset routes to the heads (fork) strategy', async () => {
    const t = agentsTool({ fork: forkDeps() });
    const result = v.parse(StrategyResultSchema, await t.execute({ action: 'fork', task: 'x', forks: twoForks }));
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

  test('the fork brief says what a brief must carry, and what a fork can see', async () => {
    // The most failure-prone artifact in the system had 16 words of guidance:
    // "What this fork explores. Be concrete." / "Why this angle matters." What
    // must be in a brief follows from what a fork can SEE — the workspace and
    // the parent's completed turns, never this conversation as it continues and
    // never a sibling — so the acceptance criterion has to be in the brief
    // because nothing else can tell the fork it is done.
    const schema = v.parse(v.object({ jsonSchema: v.object({ properties: v.object({
      task: v.object({ description: v.string() }),
      forks: v.object({ items: v.object({ properties: v.object({
        task: v.object({ description: v.string() }),
        rationale: v.object({ description: v.string() }),
      }) }) }),
    }) }) }), agentsTool({ fork: forkDeps() }).inputSchema);
    const { task, forks } = schema.jsonSchema.properties;
    const brief = forks.items.properties.task.description;
    expect(brief).toMatch(/complete on its own/);
    expect(brief).toMatch(/the observable result that means it is done/);
    // The inheritance half is DELEGATION_INHERITANCE.fork.brief, byte-for-byte —
    // the same per-action source the fork RUNG composes, so the two surfaces
    // cannot disagree about what a fork can see. They did: this field used to say
    // a fork "sees this workspace but not this conversation", which is false —
    // heads are spawned with up to 50 of the parent's stored messages AS their
    // conversation. What a fork actually cannot see is this turn continuing and
    // its siblings, and that is what it says now.
    expect(brief).toContain(DELEGATION_INHERITANCE.fork.brief);
    expect(brief).toMatch(/build on what you already established rather than restating it/);
    expect(brief).not.toMatch(/not this conversation/);
    // …and the hire brief is its OPPOSITE, from the same record: neither field
    // can be handed the other's rule, which is the whole point of keying it on
    // the action instead of writing one paragraph for both.
    expect(DELEGATION_INHERITANCE.hire.brief).toMatch(/did not watch this conversation/);
    expect(DELEGATION_INHERITANCE.hire.brief).toMatch(/rather than assuming shared ground/);
    expect(forks.items.properties.rationale.description).toMatch(/read at the merge to weigh what came back/);
    // The batch slot carries the shared background ONCE — oh-my-pi's `context`
    // role — while staying literally the task, because settle=mcts reads this
    // field alone and never looks at `forks`.
    expect(task.description).toMatch(/the task the forks explore together and the context they share/);
    expect(task.description).toMatch(/State it here once rather than repeating it in each fork/);
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
    const result = v.parse(ErrorResultSchema, await t.execute({ action: 'fork', task: 't', forks: twoForks }));
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
    await t.execute({ action: 'fork', task: 't', forks: twoForks, options: { heads: { count: 5 } } });
    // Untouched strategy bag passes through verbatim.
    expect(strategyOption(observedOpts, 'mcts')).toEqual({ iterations: 7 });
    // One-level deep merge: caller's `count` overrides, but the host-injected
    // `controller` is NOT clobbered. This is the bug the shallow spread had.
    expect(strategyOption(observedOpts, 'heads')).toEqual({ controller, count: 5, heads: twoForks });
  });

  test('an array option replaces a strategy bag instead of becoming numeric object keys', async () => {
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
    const t = agentsTool({
      fork: {
        registry: reg, rt, model: testModel,
        defaultOptions: () => ({ mcts: { session: { __infra: true } } }),
      },
    });

    // Any strategy bag: the merge path's own `heads` bag is written by the
    // forks fold, so the array-replacement rule is pinned on another key.
    await t.execute({ action: 'fork', task: 't', forks: twoForks, options: { mcts: ['one', 'two'] } });

    expect(strategyOption(observedOpts, 'mcts')).toEqual(['one', 'two']);
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
    await t.execute({ action: 'fork', task: 't', forks: twoForks, merge_strategy: 'consensus' });
    // Injected controller + LLM-supplied specs coexist under options.heads.
    expect(strategyOption(observedOpts, 'heads')).toEqual({ controller, heads: twoForks, mergeStrategy: 'consensus' });
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
    await t.execute({ action: 'fork', task: 't', forks: twoForks, budget: 42, wall_clock_ms: 999 });
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

// ── fork — the forks/settle contract ────────────────────────────────────────

/**
 * `forks` and `settle` are one contract in two directions, and both halves used
 * to be documentation alone:
 *
 *   settle=mcts DISCARDED the briefs. The fold into `options.heads` ran
 *   unconditionally, and the MCTS strategy runs on `ctx.task` and never reads
 *   that option (strategy/mcts.ts:80) — so three careful briefs with their own
 *   `model` and `allowedTools` produced toolless codegen on the task string,
 *   reported as an ordinary success.
 *
 *   settle=merge WITHOUT briefs degraded past the spawn announcement. The
 *   schema said "Required when settling by merge" and nothing enforced it, so
 *   the call announced its spawn (agents-tool.ts, readSpawnStarted), detached
 *   into a background job, and the heads strategy's throw came back as a wake
 *   claiming the spawned work failed — for a fork that never spawned.
 *
 * Both are now refusals at the seam, classified `bad_input` like every other
 * arguments-do-not-describe-an-operation refusal in this codebase.
 */
describe('agents tool — the forks/settle contract', () => {
  const RefusalSchema = v.object({ reason: v.string(), error: v.string() });

  const briefs = [
    { task: 'read the gateway logs', rationale: 'where the failure shows', model: 'codex/gpt-5.5', allowedTools: ['file'] },
    { task: 'diff the last deploy', rationale: 'timing points at the release' },
  ];

  /** A fork surface whose strategies RECORD their dispatch, so a refusal is
   *  distinguishable from a call that ran and threw the briefs away. */
  function recordingFork() {
    const dispatched: string[] = [];
    const reg = createStrategyRegistry();
    for (const id of [FORK_STRATEGY_ID, 'mcts']) {
      reg.register({
        id,
        async explore() {
          dispatched.push(id);
          return { strategy: id, best: { text: 'ran', score: 1, source: id }, all: [], cost: { durationMs: 0 } };
        },
      });
    }
    const { rt } = createTestRuntime();
    return { dispatched, tool: agentsTool({ fork: { registry: reg, rt, model: testModel } }) };
  }

  /** The options bag the background wrapper arms on a spawn-shaped call. Built
   *  here rather than inline so the extra key is not an excess property on a
   *  fresh `ToolExecutionOptions` literal. */
  function spawnAnnouncing(announce: () => void) {
    return { toolCallId: 'tc-merge', messages: [], [SPAWN_STARTED_OPTION]: announce };
  }

  test('settle=mcts with hand-authored forks is REFUSED, not run on the task alone', async () => {
    const { dispatched, tool } = recordingFork();
    const result = v.parse(RefusalSchema, await tool.execute({
      action: 'fork', task: 'why staging 502s under load', settle: 'mcts', forks: briefs,
    }));
    // Nothing ran, so nothing was discarded.
    expect(dispatched).toEqual([]);
    expect(result.reason).toBe('bad_input');
    // The refusal names the conflict and BOTH remedies — drop the briefs, or
    // settle by merge and have them run as real forks.
    expect(result.error).toContain('settle=mcts');
    expect(result.error).toContain('settle=merge');
    expect(result.error).toMatch(/\bforks\b/);
  });

  test('merge_strategy is refused under a settle that never merges', async () => {
    // The same silent discard in the same field family: `merge_strategy` is
    // read by the merge only (strategy/heads.ts), and nothing else looks at it.
    const { dispatched, tool } = recordingFork();
    const result = v.parse(RefusalSchema, await tool.execute({
      action: 'fork', task: 't', settle: 'mcts', merge_strategy: 'consensus',
    }));
    expect(dispatched).toEqual([]);
    expect(result.reason).toBe('bad_input');
    expect(result.error).toContain('`merge_strategy`');
  });

  test('settle=merge with no forks is refused at the seam — before the spawn is announced', async () => {
    const { dispatched, tool } = recordingFork();
    let announced = 0;
    const result = v.parse(RefusalSchema, await tool.execute(
      { action: 'fork', task: 'split the work' },
      spawnAnnouncing(() => { announced += 1; }),
    ));
    expect(dispatched).toEqual([]);
    // The whole point of enforcing here: an unspawnable fork must not detach
    // and come back as a wake about work that never started.
    expect(announced).toBe(0);
    expect(result.reason).toBe('bad_input');
    expect(result.error).toMatch(/\bforks\b/);
  });

  test('an empty forks array is the same refusal as none at all', async () => {
    const { dispatched, tool } = recordingFork();
    const result = v.parse(RefusalSchema, await tool.execute({ action: 'fork', task: 't', forks: [] }));
    expect(dispatched).toEqual([]);
    expect(result.reason).toBe('bad_input');
  });

  test('the refusal only offers mcts as a remedy where mcts is registered', async () => {
    const reg = createStrategyRegistry();
    reg.register(createTestStrategy({ id: FORK_STRATEGY_ID, answer: 'forked' }));
    const { rt } = createTestRuntime();
    const tool = agentsTool({ fork: { registry: reg, rt, model: testModel } });
    const result = v.parse(RefusalSchema, await tool.execute({ action: 'fork', task: 't' }));
    expect(result.error).not.toContain('mcts');
  });

  test('settle=merge WITH forks still folds them into options.heads and runs', async () => {
    const { dispatched, tool } = recordingFork();
    const result = v.parse(StrategyResultSchema, await tool.execute({
      action: 'fork', task: 'why staging 502s under load', forks: briefs,
    }));
    expect(dispatched).toEqual([FORK_STRATEGY_ID]);
    expect(result.strategy).toBe(FORK_STRATEGY_ID);
  });

  test('a fork refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    // The refusal reason is the vocabulary read-models/tool-failures.ts
    // classifies, so a correct refusal lands in `refused` instead of indicting
    // the tool in `broke` — which is where the old bare `{error}` envelopes went.
    const { tool } = recordingFork();
    const args: AgentsToolInput = { action: 'fork', task: 't', settle: 'mcts', forks: briefs };
    const result = await tool.execute(args);
    const failure = classifyToolFailure({
      type: 'tool_call_end', eventIndex: 0, runId: 'run-1',
      timestamp: new Date().toISOString(), name: 'agents', toolCallId: 'tc-1',
      args: v.parse(JsonObjectSchema, args), result: v.parse(JsonObjectSchema, result),
    });
    expect(failure).toEqual({
      tool: 'agents', action: 'fork', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('the schema says which settle takes briefs and which one gets a tool loop', () => {
    const schema = v.parse(v.object({ jsonSchema: v.object({ properties: v.object({
      forks: v.object({ description: v.string() }),
      settle: v.object({ description: v.string() }),
    }) }) }), agentsTool({ fork: forkDeps() }).inputSchema);
    const { forks, settle } = schema.jsonSchema.properties;
    // Required for merge, refused for anything else — stated on the field the
    // model fills, in both directions.
    expect(forks.description).toMatch(/[Rr]equired.*settle=merge/);
    expect(forks.description).toMatch(/[Rr]efused under settle=mcts/);
    // The tool-loop distinction: a merge fork is an agent, an mcts branch is a
    // single scored proposal.
    expect(settle.description).toMatch(/tool loop/);
    expect(settle.description).toMatch(/\bforks\b/);
  });
});

// ── hire / ask / send — subordinates ────────────────────────────────────────

describe('agents tool — subordinate actions', () => {
  test('the host-stamped Plan mode reaches hire, ask, and send without a model field', async () => {
    const team = makeTeam();
    const tool = agentsTool({ mode: 'plan', team: team.deps });

    await tool.execute({ action: 'hire', role: 'researcher', mission: 'Map without editing' });
    await tool.execute({ action: 'ask', agent: 'researcher', message: 'Inspect the design' });
    await tool.execute({ action: 'send', agent: 'researcher', message: 'Stay read-only' });

    expect(team.calls).toMatchObject([
      { action: 'spawn', input: { mode: 'plan' } },
      { action: 'assign', input: { mode: 'plan' } },
      { action: 'message', input: { mode: 'plan' } },
    ]);
  });

  test('hire forwards role/mission (+ optional agent name/model) to team.spawn', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({
      action: 'hire', role: 'researcher', mission: 'Map the landscape', model: 'openai/gpt-5',
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

  test('list returns the unified roster; empty roster hints hire', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });
    expect(await t.execute({ action: 'list' })).toEqual({ subordinates: [rosterEntry] });

    const empty = agentsTool({ team: makeTeam({ list: async () => [] }).deps });
    const emptyResult = v.parse(v.object({
      subordinates: v.array(v.unknown()), note: v.optional(v.string()),
    }), await empty.execute({ action: 'list' }));
    expect(emptyResult.subordinates).toEqual([]);
    expect(emptyResult.note).toContain('hire');
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
    expect(await t.execute({ action: 'hire', role: 'r' })).toEqual({ error: 'hire requires role and mission' });
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

// ── ask / send / reply / hire scope=workspace — peers ───────────────────────

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

  test('hire scope=workspace forwards mission as purpose + message (the old spawn_workspace, verbatim transport)', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    const result = await t.execute({
      action: 'hire', scope: 'workspace', mission: 'summarize research papers', message: 'Summarize X',
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
    expect(await t.execute({ action: 'hire', scope: 'workspace', message: 'x' }))
      .toEqual({ error: 'hire scope=workspace requires mission and message' });
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

// ── replaying a stored fork row ─────────────────────────────────────────────
// A durable job row holds whatever the model sent, verbatim (jobs/runner.ts
// stores the raw tool input), so rows written before the strict parse can carry
// fields it now refuses. A row is RE-DRIVEN, not answered: there is no model
// listening for a correction, and a refusal here is an interrupted fork lost to
// a spelling nobody can fix any more. So the filter translates, and says what it
// dropped.

describe('agents tool — resuming a stored fork row', () => {
  /** `diagnostics` writes one JSON line per event to console.error, and has no
   *  injection seam this far inside core — so the line is read where it lands.
   *  Reassignment rather than spyOn: the same reason unit-mcts-resume.test.ts
   *  gives. */
  function captureEvents<Result>(run: () => Result) {
    const original = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(String(args[0])); };
    try {
      return { result: run(), lines };
    } finally {
      console.error = original;
    }
  }

  test('a row of fork fields resumes exactly as it was stored', () => {
    expect(resumableForkInput('agents', {
      action: 'fork', task: 'search', settle: 'mcts', budget_usd: 5,
    })).toEqual({ action: 'fork', task: 'search', settle: 'mcts', budget_usd: 5 });
  });

  test('a row carrying a field the parse now refuses still resumes, and the drop is logged', () => {
    const { result: resumed, lines } = captureEvents(() => resumableForkInput('agents', {
      action: 'fork', task: 'search', settle: 'mcts', budgetUsd: 5,
    }));
    // Translated, not refused: `budgetUsd` never applied on the original
    // dispatch either, so the re-drive reproduces that run rather than failing.
    expect(resumed).toEqual({ action: 'fork', task: 'search', settle: 'mcts' });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    // Named, not counted: a resumed fork that lost a cap is only diagnosable if
    // the line says which field went.
    expect(dropped[0]).toContain('budgetUsd');
  });

  test('a stored non-fork field is narrowed away, so the re-drive is not refused', async () => {
    // The trap one layer deeper than the parse: `topic` is a DECLARED field, so
    // a lenient parse would keep it, and the strict parse at the tool would then
    // refuse the whole re-drive because `fork` does not read it. The filter
    // builds the call out of fork's fields alone, which is what makes the row
    // replayable at all.
    const { result: resumed, lines } = captureEvents(() => resumableForkInput('agents', {
      action: 'fork', task: 'search', forks: twoForks, topic: 'stale',
    }));
    expect(resumed).toEqual({ action: 'fork', task: 'search', forks: twoForks });
    expect(lines.filter((line) => line.includes('agents.resume.fields_dropped'))).toHaveLength(1);
    if (!resumed) throw new Error('expected a resumable fork input');
    const result = v.parse(StrategyResultSchema, await agentsTool({ fork: forkDeps() }).execute(resumed));
    expect(result.strategy).toBe(FORK_STRATEGY_ID);
  });

  test('a stored row for any other action is not resumable', () => {
    expect(resumableForkInput('agents', { action: 'hire', role: 'r', mission: 'm' })).toBeNull();
    expect(resumableForkInput('run', { command: 'ls' })).toBeNull();
  });

  test('a pre-unification `think` row is translated onto the fork fields', () => {
    // Rows stored before the agents unification carry kind 'think', strategy
    // instead of settle and heads instead of forks. Their extra fields are
    // dropped by the same rule, and the result must be a call the strict parse
    // accepts.
    expect(resumableForkInput('think', {
      strategy: 'mcts', task: 'search', heads: twoForks, budget: 4, unknown_since: 'ever',
    })).toEqual({ action: 'fork', settle: 'mcts', task: 'search', forks: twoForks, budget: 4 });
  });
});
