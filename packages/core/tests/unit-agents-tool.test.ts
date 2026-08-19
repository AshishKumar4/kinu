// The unified `agents` delegation tool — one surface where the KIND of helper
// is a parameter. Pins the whole tool-side contract:
//   swarm   — the configured-search rung: preset/objective refusals, mission
//             caps, and the background spawn announcement.
//   hire    — subordinate spawn (and scope=workspace → peer spawnWorkspace).
//   ask/send/reply/list/dismiss — one addressing scheme across subordinates
//             and peer workspace agents, timeout clamping, the reserved
//             reply topic, and the PERSISTENCE semantic (dismiss archives by
//             default; completion never evicts).
// The transports themselves (facet substrate, peer outbox, waiters, reply
// channels, node runtime) are exercised in cf-backend tests against the real
// hubs; deps here are recorders.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, createTestStrategy, toolExecute } from '@proteus/test-utils';
import { MockLanguageModelV3 } from 'ai/test';
import * as v from 'valibot';
import { AGENTS_ACTION_FIELDS } from '../src/tools/agents-tool';
import { SWARM_PRESETS } from '../src/strategy/swarm';
import {
  agentsActionsFor, buildBuiltinTools, createAgentsTool, createStrategyRegistry,
  renderAgentsToolDescription, resumableAgentsInput,
  AGENTS_TOOL_ACTIONS, BUILTIN_TOOL_DESCRIPTIONS, DELEGATION_INHERITANCE, DELEGATION_RUNGS,
  delegationBudgetAtDepth, ROOT_DELEGATION_BUDGET,
  SWARM_PRESET_DOCTRINE,
  FORK_STRATEGY_ID, PEER_REPLY_TOPIC, SPAWN_STARTED_OPTION, TURN_WALL_CLOCK_ENVELOPE_MS,
  classifyToolFailure, JsonObjectSchema,
  type AgentsToolInput,
  type AgentsForkDeps, type AgentsToolDeps, type PeersToolDeps,
  type SubordinateRosterEntry, type TeamToolDeps,
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
const ErrorResultSchema = v.object({ error: v.string() });
/** The briefs a STORED `fork` row carried. Kept as a fixture because the resume
 *  translation has to name them as dropped; no live call takes them. */
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

  test('the exploration substrate (the CLI / subordinate surface) exposes the search rung alone', () => {
    const deps = withBuildMode({ fork: forkDeps() });
    // By construction rather than by wiring: `swarm` needs a model to expand with
    // and a workspace to measure in, which is exactly what that substrate carries,
    // so there is no deps group a backend could wire half of.
    expect(agentsActionsFor(deps)).toEqual(['swarm']);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).toEqual(['swarm']);
    // The docstring drops the hire rung and the converse verbs entirely.
    expect(t.description).toContain(DELEGATION_RUNGS.swarm);
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
    expect(actionEnum({ value: t.inputSchema })).not.toContain('swarm');
    expect(renderAgentsToolDescription(deps)).not.toContain('scope=workspace');
  });

  test('an unavailable action is a sharp error, not a deps call', async () => {
    const t = agentsTool({ fork: forkDeps() });
    expect(await t.execute({ action: 'hire', role: 'r', mission: 'm' }))
      .toEqual({
        reason: 'unsupported',
        error: 'action "hire" is not available here. Available: swarm',
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
      action: 'swarm', task: 'explore', budgetUsd: 5, budgetLabel: 'audit',
    } as AgentsToolInput));
    expect(refusal.reason).toBe('bad_input');
    expect(refusal.error).toContain('unknown field "budgetUsd" — did you mean "budget_usd"?');
    expect(refusal.error).toContain('unknown field "budgetLabel" — did you mean "budget_label"?');
  });

  test('the refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    // Same vocabulary read-models/tool-failures.ts classifies. A parse refusal
    // is the caller's spelling, so it must land in `refused` rather than
    // indicting the tool in `broke` — otherwise closing one silence buys a
    // false defect rate in the ledger.
    const args = { action: 'swarm', task: 'explore', budgetUsd: 5 };
    /* SAFETY: the mis-spelled field is the subject of the test. Every field name
       is validated by `execute` before any field is read, so this object is
       refused rather than acted on. */
    const result = await agentsTool({ fork: forkDeps() }).execute(args as AgentsToolInput);
    expect(classifyToolFailure({
      type: 'tool_call_end', eventIndex: 0, runId: 'run-1',
      timestamp: new Date().toISOString(), name: 'agents', toolCallId: 'tc-1',
      args: v.parse(JsonObjectSchema, args), result: v.parse(JsonObjectSchema, result),
    })).toEqual({
      tool: 'agents', action: 'swarm', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('the correctly spelled call reaches the handler — the refusal is about names, not caps', async () => {
    // The control. Without it the refusal above could be a tool that refuses every
    // call carrying a budget. The snake_case call gets PAST the name check and is
    // answered by the handler's own missing-`preset` refusal, which is how we know
    // the caps were accepted rather than rejected under another name.
    const t = agentsTool({ fork: forkDeps() });
    const refusal = v.parse(ErrorResultSchema, await t.execute({
      action: 'swarm', task: 'explore', budget_usd: 5, budget_label: 'audit',
    }));
    expect(refusal.error).toContain('swarm needs `preset`');
    expect(refusal.error).not.toContain('unknown field');
  });

  /** One advertised property's description, off the real tool the model is handed. */
  function propertyDescription(input: { value: unknown }, field: string): string {
    const properties = v.parse(v.object({
      jsonSchema: v.object({ properties: v.record(v.string(), v.object({ description: v.string() })) }),
    }), input.value).jsonSchema.properties;
    const property = properties[field];
    if (!property) throw new Error(`the swarm surface advertises no \`${field}\``);
    return property.description;
  }

  test('the preset list reaches the model where `preset` is filled, from the one constant', () => {
    // It used to be four hand-written copies — this property, the missing-`preset`
    // refusal, the swarm rung and the codemode declaration — and they disagreed:
    // `prove` was selectable and named in none of them, while research/audit/
    // redteam went on being described as working after their rows stopped
    // resolving. One constant, rendered where the field is typed.
    const t = agentsTool({ fork: forkDeps() });
    const preset = propertyDescription({ value: t.inputSchema }, 'preset');
    expect(preset).toContain(SWARM_PRESET_DOCTRINE.join(' '));
    for (const name of SWARM_PRESETS) expect(preset).toContain(name);
  });

  test('the missing-`preset` refusal names the same presets the property does', async () => {
    const refusal = v.parse(ErrorResultSchema, await agentsTool({ fork: forkDeps() }).execute({
      action: 'swarm', task: 'explore',
    }));
    expect(refusal.error).toContain(SWARM_PRESET_DOCTRINE.join(' '));
  });

  test('the objective kinds this runner cannot measure are advertised as refused', () => {
    // `measuredHalf` returns null for kind:"instanced" and kind:"vector", so a
    // score:"verify" run over either is refused as unsupported — and advance:
    // "pareto", their only consumer, is refused unconditionally by the same
    // runner. The description called them "the two front shapes", which reads as
    // an offer: the model builds the nested objective and loses the call.
    const objective = propertyDescription({ value: agentsTool({ fork: forkDeps() }).inputSchema }, 'objective');
    expect(objective).toContain('both are refused today');
    expect(objective).not.toContain('are the two front shapes');
    // The two reachable kinds keep their instructions.
    expect(objective).toContain('{kind:"scalar"');
    expect(objective).toContain('kind:"witness" is a checkable certificate');
  });

  test('a cap on an action that cannot spend it is refused, not accepted and ignored', async () => {
    // `budget_usd` is real, and only `swarm` reads it: the host meters a search it
    // owns, while a subordinate runs on its own storage and is gated at the spawn
    // seam instead. Sent to `hire` it parsed cleanly and was then read by nothing
    // at all, which is the same silence one layer in.
    const team = makeTeam();
    const t = agentsTool({ team: team.deps });
    const refusal = v.parse(ErrorResultSchema, await t.execute({
      action: 'hire', role: 'researcher', mission: 'survey the landscape', budget_usd: 5,
    }));
    expect(refusal.error).toContain('field "budget_usd" does not apply to action "hire"');
    expect(refusal.error).toContain('it is read by swarm');
    expect(refusal.error).toContain('action "hire" takes: agent, role, mission');
    // Refused BEFORE the spawn, so nothing was hired under a cap nothing holds.
    expect(team.calls).toEqual([]);
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
    // can differ. An actor holding only the exploration substrate is offered the
    // search rung's fields and nothing from the converse half.
    const searchOnly = propertyNames({ value: agentsTool({ fork: forkDeps() }).inputSchema }).sort();
    expect(searchOnly).toEqual(['action', ...AGENTS_ACTION_FIELDS.swarm].sort());
    // And the converse half really is absent, so the subset is a subset.
    expect(searchOnly).not.toContain('agent');
    expect(searchOnly).not.toContain('mission');
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

// ── swarm — the refusal seam, before anything spawns ────────────────────────

/**
 * A call that cannot run must be refused BEFORE the spawn is announced.
 *
 * The shape this defends against is measured: a call whose required field was
 * only documented degraded past the spawn announcement (agents-tool.ts,
 * readSpawnStarted), detached into a background job, and the engine's throw came
 * back as a wake claiming the spawned work had failed — for work that never
 * started. Every validation refusal therefore returns above that line, and it is
 * classified `bad_input` like every other arguments-do-not-describe-an-operation
 * refusal in this codebase.
 */
describe('agents tool — the swarm refusal seam', () => {
  const RefusalSchema = v.object({ reason: v.string(), error: v.string() });

  /** The options bag the background wrapper arms on a spawn-shaped call. Built
   *  here rather than inline so the extra key is not an excess property on a
   *  fresh `ToolExecutionOptions` literal. */
  function spawnAnnouncing(announce: () => void) {
    return { toolCallId: 'tc-swarm', messages: [], [SPAWN_STARTED_OPTION]: announce };
  }

  test('a swarm with no preset is refused at the seam — before the spawn is announced', async () => {
    const tool = agentsTool({ fork: forkDeps() });
    let announced = 0;
    const result = v.parse(RefusalSchema, await tool.execute(
      { action: 'swarm', task: 'split the work' },
      spawnAnnouncing(() => { announced += 1; }),
    ));
    // The whole point of enforcing here: an unrunnable search must not detach
    // and come back as a wake about work that never started.
    expect(announced).toBe(0);
    expect(result.reason).toBe('bad_input');
    expect(result.error).toMatch(/\bpreset\b/);
  });

  test('a swarm with no task is the same refusal, and names where the metric goes', async () => {
    const tool = agentsTool({ fork: forkDeps() });
    let announced = 0;
    const result = v.parse(RefusalSchema, await tool.execute(
      { action: 'swarm', preset: 'ideate' },
      spawnAnnouncing(() => { announced += 1; }),
    ));
    expect(announced).toBe(0);
    expect(result.reason).toBe('bad_input');
    expect(result.error).toContain('`objective`');
  });

  test('a swarm refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    // The refusal reason is the vocabulary read-models/tool-failures.ts
    // classifies, so a correct refusal lands in `refused` instead of indicting
    // the tool in `broke` — which is where the old bare `{error}` envelopes went.
    const tool = agentsTool({ fork: forkDeps() });
    const args: AgentsToolInput = { action: 'swarm', task: 't' };
    const result = await tool.execute(args);
    expect(classifyToolFailure({
      type: 'tool_call_end', eventIndex: 0, runId: 'run-1',
      timestamp: new Date().toISOString(), name: 'agents', toolCallId: 'tc-1',
      args: v.parse(JsonObjectSchema, args), result: v.parse(JsonObjectSchema, result),
    })).toEqual({
      tool: 'agents', action: 'swarm', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('the task field states what it is for, and what a node can lean on', () => {
    const schema = v.parse(v.object({ jsonSchema: v.object({ properties: v.object({
      task: v.object({ description: v.string() }),
    }) }) }), agentsTool({ fork: forkDeps() }).inputSchema);
    const { task } = schema.jsonSchema.properties;
    expect(task.description).toMatch(/what the search is for, in prose/);
    expect(task.description).toMatch(/never the measured quantity/);
    // The inheritance half is DELEGATION_INHERITANCE.swarm.brief, byte-for-byte —
    // the same per-action source the rung composes, so the field and the rung
    // cannot come to disagree about what a node can see.
    expect(task.description).toContain(DELEGATION_INHERITANCE.swarm.brief);
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

  test('peer ask defaults: topic "message", one measured turn; a small ask is honoured, a huge one clamps', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x' });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 1 });
    await t.execute({ action: 'ask', agent: 'scout', message: 'x', timeout_seconds: 9999 });
    const peerInputs = calls.map((call) => v.parse(v.object({
      timeoutMs: v.number(), topic: v.string(),
    }), call.input));
    // The default IS the ceiling, because an ask waits on the addressed agent's whole
    // turn and 120_000 was under every turn measured. A caller asking for 1s gets 1s:
    // the 5_000 floor that used to raise it silently overrode a deliberate request,
    // and a `no_reply` whose note says the answer lands later as an event is honest.
    expect(peerInputs.map((input) => input.timeoutMs))
      .toEqual([TURN_WALL_CLOCK_ENVELOPE_MS, 1_000, TURN_WALL_CLOCK_ENVELOPE_MS]);
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
      purpose: 'summarize research papers', message: 'Summarize X',
      timeoutMs: TURN_WALL_CLOCK_ENVELOPE_MS,
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

// ── replaying a stored delegation row ───────────────────────────────────────
// A durable job row holds whatever the model sent, verbatim (jobs/runner.ts
// stores the raw tool input), so rows written before today's surface can carry
// fields it now refuses — and can name an ACTION it no longer has. A row is
// RE-DRIVEN, not answered: there is no model listening for a correction, and a
// refusal here is interrupted work lost to a spelling nobody can fix any more.
// So the filter TRANSLATES, and says what it could not carry.
//
// The same predicate is the DETACH gate (orchestrator/background-tools.ts), so
// these tests also pin what `agents` may background at all.

describe('agents tool — resuming a stored delegation row', () => {
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

  test('a row of swarm fields resumes exactly as it was stored', () => {
    // And this is what keeps `agents` backgroundable: the detach gate is this
    // same call, so a non-null answer here is what lets a live search detach.
    expect(resumableAgentsInput('agents', {
      action: 'swarm', preset: 'optimise', task: 'search', depth: 3, budget_usd: 5,
    })).toEqual({ action: 'swarm', preset: 'optimise', task: 'search', depth: 3, budget_usd: 5 });
  });

  test('a stored fork row is re-driven as the action that spawns nodes today', () => {
    // The rung is gone and the row is history. A stored fork WAS ephemeral
    // tool-using children on inherited context, which is what a search is now —
    // mapped onto `preset:'ideate'`, the one preset that writes its own competing
    // approaches from `task` alone, because the row carries no `objective` and
    // none can be invented for it. The caps carry, because dropping a cap is the
    // one loss that would make the re-drive cost MORE than the run it resumes.
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'fork', task: 'search', forks: twoForks, merge_strategy: 'consensus', budget_usd: 5,
    }));
    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search', budget_usd: 5 });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    // Named, not counted: the briefs and the merge are the loss, and a re-drive
    // that lost them is only diagnosable if the line says so.
    expect(dropped[0]).toContain('forks');
    expect(dropped[0]).toContain('merge_strategy');
    expect(dropped[0]).toContain('settlement');
    expect(dropped[0]).not.toContain('budget_usd');
  });

  test('a stored settle row takes the same translation, from one era further back', () => {
    // `settle` stopped being an entry when tree search became an action, so it
    // arrives as an unknown key on the raw row and is named in the same line.
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'fork', task: 'search', settle: 'mcts', budget_tokens: 900,
    }));
    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search', budget_tokens: 900 });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('settle');
    expect(dropped[0]).toContain('settlement');
  });

  test('a row carrying a field the parse now refuses still resumes, and the drop is logged', () => {
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'swarm', preset: 'ideate', task: 'search', budgetUsd: 5,
    }));
    // Translated, not refused: `budgetUsd` never applied on the original
    // dispatch either, so the re-drive reproduces that run rather than failing.
    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search' });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    // Named, not counted: a resumed search that lost a cap is only diagnosable if
    // the line says which field went.
    expect(dropped[0]).toContain('budgetUsd');
  });

  test('a stored field the target action does not read is narrowed away, so the re-drive is not refused', async () => {
    // The trap one layer deeper than the parse: `topic` is a DECLARED field, so a
    // lenient parse would keep it, and the strict parse at the tool would then
    // refuse the whole re-drive because `swarm` does not read it. The filter
    // builds the call out of the target action's fields alone, which is what
    // makes the row replayable at all — proved by driving the tool with it.
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'swarm', preset: 'ideate', task: 'search', topic: 'stale',
    }));
    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search' });
    expect(lines.filter((line) => line.includes('agents.resume.fields_dropped'))).toHaveLength(1);
    if (!resumed) throw new Error('expected a resumable agents input');
    const replayed = v.parse(v.record(v.string(), v.unknown()), await agentsTool({ fork: forkDeps() }).execute(resumed));
    // Not refused, and positively so: the re-drive reached the engine and came
    // back with a run report, which it could not have if `topic` had survived
    // into the strict parse.
    expect(replayed['reason']).toBeUndefined();
    expect(replayed['error']).toBeUndefined();
    expect(replayed['report']).toBeDefined();
  });

  test('a stored row for a converse action is not resumable, and neither is another tool', () => {
    // This is also the detach gate saying no: an `agents` call that cannot be
    // re-driven must never detach into a job in the first place.
    expect(resumableAgentsInput('agents', { action: 'hire', role: 'r', mission: 'm' })).toBeNull();
    expect(resumableAgentsInput('agents', { action: 'ask', agent: 'a', message: 'm' })).toBeNull();
    expect(resumableAgentsInput('run', { command: 'ls' })).toBeNull();
  });

  test('a pre-unification `think` row is translated onto the search action', () => {
    // Rows stored before the agents unification carry kind 'think', `heads`
    // instead of briefs, and a `strategy` naming the engine directly. Every one
    // of those is dropped by the same rule, and the result must be a call the
    // strict parse accepts.
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('think', {
      strategy: FORK_STRATEGY_ID, task: 'search', heads: twoForks, budget: 4, unknown_since: 'ever',
    }));
    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search' });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('heads');
    expect(dropped[0]).toContain('unknown_since');
    expect(dropped[0]).toContain('settlement');
  });

  test('a legacy `think` row whose strategy was a tree search replays the same way', () => {
    // A row from either era that asked for several attempts gets the one action
    // that runs them, and loses the same settlement — so the translation does not
    // depend on which engine the row happened to name.
    const { result: resumed } = captureEvents(() => resumableAgentsInput('think', {
      strategy: 'mcts', task: 'search', heads: twoForks, budget: 4,
    }));
    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search' });
  });
});
