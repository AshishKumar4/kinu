// Tool-side contract of the unified `agents` tool; transports are covered in cf-backend tests.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, toolExecute, scriptedTurnModel, unobservedSearchSeams } from '@kinu.run/test-utils';
import { hostedSeatsOver } from './helpers-actor-host';

import * as v from 'valibot';
import { AGENTS_ACTION_FIELDS } from '../src/delegation/agents-tool';
import { DELEGATION_CONTEXT_DESCRIPTION } from '../src/tools/registry';
import { SWARM_PRESETS } from '../src/strategy/swarm';
import {
  agentsActionsFor, buildBuiltinTools, createAgentsTool, parseAgentsToolInput,
  renderAgentsToolDescription, resumableAgentsInput,
  AGENTS_TOOL_ACTIONS, BUILTIN_TOOL_DESCRIPTIONS, DELEGATION_INHERITANCE, DELEGATION_RUNGS,
  delegationBudgetAtDepth, ROOT_DELEGATION_BUDGET,
  SWARM_PRESET_DOCTRINE,
  PEER_REPLY_TOPIC, SPAWN_STARTED_OPTION,
  classifyToolFailure, JsonObjectSchema, failedToolOutcome,
  type AgentsToolInput,
  type AgentsSwarmDeps, type AgentsToolDeps, type PeersToolDeps,
  type AgentsProfileContext,
  type SubordinateRosterEntry, type TeamToolDeps,
  type SubordinateDelivery, type SubordinateHandoff,
  BUILTIN_PROFILE_CATALOG, profileCatalogDigest, DEFAULT_WORKERS_AI_MODEL_SPEC,
} from '../src/index';
import { renderThrownChain } from '../src/obs/index';
import { inWorkMode } from '../src/execution/work-mode';
import { buildToolSurface } from '../src/tools/builtins';
import { storesFor } from './helpers';

async function recordedFailure(pending: Promise<AgentsTestResult>, args: AgentsToolInput) {
  try { await pending; }
  catch (cause) {
    return classifyToolFailure({ type: 'tool_call_end', eventIndex: 0, runId: 'run-1',
      timestamp: new Date().toISOString(), name: 'agents', toolCallId: 'tc-1',
      args: v.parse(JsonObjectSchema, args), error: renderThrownChain({ cause }), outcome: failedToolOutcome({ cause }) });
  }

  throw new Error('the native agents invocation did not fail');
}

interface Call { action: string; input: object }

type AgentsTestResult = object | string | number | boolean | null | undefined;

type TestAgentsToolDeps = Omit<AgentsToolDeps, 'mode'> & { mode?: AgentsToolDeps['mode'] };

function testProfile(): AgentsProfileContext {
  const catalog = {
    roles: BUILTIN_PROFILE_CATALOG.roles,
    tiers: {
      default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC },
      fast: { model: DEFAULT_WORKERS_AI_MODEL_SPEC },
      deep: { model: DEFAULT_WORKERS_AI_MODEL_SPEC },
    },
  };

  return {
    envelope: {
      authority: { kind: 'local' } as const,
      version: 0,
      digest: profileCatalogDigest(catalog),
      catalog,
    },
    provider: { revision: 'test-1', availableModels: [DEFAULT_WORKERS_AI_MODEL_SPEC] },
    roleId: 'task',
    availableTools: [],
  };
}

function withBuildMode(deps: TestAgentsToolDeps): AgentsToolDeps {
  return { mode: 'build', ...deps };
}

function agentsTool(deps: TestAgentsToolDeps) {
  const entry = createAgentsTool(withBuildMode(deps));

  if (!entry) throw new Error('Expected agents tool to be created');

  return { ...entry, execute: toolExecute<AgentsToolInput, AgentsTestResult>(entry) };
}

/** Answers one text step via both generate and stream; bare `MockLanguageModelV3()` implements neither. */
const testModel = scriptedTurnModel({
  modelId: 'fake-agents-tool',
  doGenerate: () => ({
    content: [{ type: 'text', text: 'A node answer.' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 3, text: 3, reasoning: undefined },
    },
    warnings: [],
  }),
});

/** Briefs a stored `fork` row carried; the resume translation must name them as dropped. */
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

/** Swarm substrate with one hosted actor per node id. */
function swarmDeps(overrides: Partial<AgentsSwarmDeps> = {}): AgentsSwarmDeps {
  const { rt, testSql } = createTestRuntime();

  return {
    rt, model: testModel,
    hostNode: hostedSeatsOver({ rt, db: testSql.db }).hostNode,
    ...unobservedSearchSeams(),
    ...overrides,
  };
}

function actionEnum(input: { value: unknown }): string[] {
  return v.parse(v.object({
    jsonSchema: v.object({
      properties: v.object({ action: v.object({ enum: v.array(v.string()) }) }),
    }),
  }), input.value).jsonSchema.properties.action.enum;
}

/** The action enum's description, where per-actor facts (verbs, remaining depth) ride. */
function actionDescription(input: { value: unknown }): string {
  return v.parse(v.object({
    jsonSchema: v.object({
      properties: v.object({ action: v.object({ description: v.string() }) }),
    }),
  }), input.value).jsonSchema.properties.action.description;
}

const rosterEntry: SubordinateRosterEntry = { name: 'researcher', actorReference: null, birth: null, deleteRequested: false, createdBy: 'orchestrator', status: 'idle', currentTask: null, createdAt: 1000, dismissedAt: null, lifetime: 'durable', taskEventId: null };

interface HandoffEcho {
  action: string;
  input: { name: string };
  delivery: SubordinateDelivery;
  busy: boolean;
}

function echoHandoff(calls: Call[], echo: HandoffEcho) {
  calls.push({ action: echo.action, input: echo.input });

  return { ok: true as const, name: echo.input.name, ...handoff(echo.delivery, echo.busy) };
}

const handoff = (delivery: SubordinateDelivery, busy: boolean): SubordinateHandoff => ({
  eventId: `evt-${delivery}`,
  delivery,
  phase: { busy, lastActivityAt: 1234, workingOn: busy ? 'reading src/auth.ts' : null },
});

/** Temporary rung port stub; its behaviour is covered by unit-temporary-agents. */
const temporaryPortStub = {
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
};

function makeTeam(
  overrides: Partial<Pick<TeamToolDeps, 'assign' | 'message' | 'list'>> = {},
) {
  const calls: Call[] = [];

  const deps: TeamToolDeps = {
    delegation: ROOT_DELEGATION_BUDGET,
    temporary: temporaryPortStub,
    snapshot: () => [rosterEntry],
    list: async () => [rosterEntry],
    create: async (input) => ({
      name: input.name ?? 'researcher',
      displayName: 'Researcher',
      subordinate: { name: input.name ?? 'researcher', displayName: 'Researcher', role: input.role ?? 'task', actorReference: null, birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
    }),
    rename: async (input) => {
      calls.push({ action: 'rename', input });

      return {
        ok: true, name: input.name, displayName: input.displayName,
        subordinate: { ...rosterEntry, name: input.name, displayName: input.displayName },
      };
    },
    recordTitle: async (input) => {
      calls.push({ action: 'recordTitle', input });

      return { ok: true, name: input.name, displayName: input.displayName, applied: true };
    },
    spawn: async (input) => {
      calls.push({ action: 'spawn', input });

      return { name: input.name ?? 'researcher', displayName: 'Researcher' };
    },
    assign: async (input) => echoHandoff(calls, {
      action: 'assign', input, delivery: 'queued', busy: true,
    }),
    knows: async () => true,
    status: async (input) => {
      calls.push({ action: 'status', input });

      return { roster: [rosterEntry] };
    },
    message: async (input) => echoHandoff(calls, {
      action: 'message', input, delivery: 'starts_now', busy: false,
    }),
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

describe('agents tool — registration and dep-gating', () => {
  test('hire accepts a birth-time context choice and refuses it on existing agents', async () => {
    expect(parseAgentsToolInput({ input: { action: 'hire', role: 'researcher', mission: 'Continue', context: 'inherit' } }))
      .toMatchObject({ context: 'inherit' });
    const { deps } = makeTeam();
    await expect(agentsTool({ team: deps, profile: testProfile }).execute({
      action: 'hire', agent: 'researcher', message: 'Continue', context: 'inherit',
    })).rejects.toMatchObject({ code: 'bad_input' });
  });

  test('no deps groups → no agents tool at all', () => {
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt, history: storesFor(rt).history });
    expect(Object.keys(tools)).not.toContain('agents');
    expect(Object.keys(tools)).not.toContain('think');
    expect(Object.keys(tools)).not.toContain('team');
    expect(Object.keys(tools)).not.toContain('peers');
  });

  test('the exploration substrate (the CLI / subordinate surface) exposes the search rung alone', () => {
    const deps = withBuildMode({ swarm: swarmDeps() });
    expect(agentsActionsFor(deps)).toEqual(['swarm']);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).toEqual(['swarm']);
    expect(t.description).toContain(DELEGATION_RUNGS.swarm);
    expect(t.description).not.toContain(DELEGATION_RUNGS.hire);
    expect(t.description).not.toContain('msg says something');
  });

  test('full deps (the workspace orchestrator) expose every action and the registry docstring verbatim', () => {
    const deps = withBuildMode({ swarm: swarmDeps(), team: makeTeam().deps, peers: makePeers().deps });
    expect(agentsActionsFor(deps)).toEqual([...AGENTS_TOOL_ACTIONS]);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).toEqual([...AGENTS_TOOL_ACTIONS]);
    expect(t.description).toBe(BUILTIN_TOOL_DESCRIPTIONS.agents);
  });

  // `lifetime` is in the schema only with a temporary substrate, so its paragraph must be too.
  test('the task lifetime is described only where the actor can run one', () => {
    const temporaryCapable = withBuildMode({ team: makeTeam().deps });
    const durableOnly = withBuildMode({ team: { ...makeTeam().deps, temporary: undefined } });

    const said = (deps: Parameters<typeof renderAgentsToolDescription>[0]): string =>
      renderAgentsToolDescription(deps);

    expect(said(temporaryCapable)).toContain('lifetime:"task"');
    expect(said(durableOnly)).not.toContain('lifetime:"task"');
    // `task` is deliberately not refused: it is ordinary English the rung may use.
    expect(said(durableOnly)).not.toMatch(/lifetime|default|durable/i);
    expect(said(durableOnly)).toContain('Hire a helper (action=hire)');
    expect(said(durableOnly)).toContain('stays in your roster');

    const props = (deps: Parameters<typeof agentsTool>[0]): string[] => Object.keys(
      v.parse(v.object({ jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }) }), agentsTool(deps).inputSchema).jsonSchema.properties,
    );

    expect(props(temporaryCapable)).toContain('lifetime');
    expect(props(durableOnly)).not.toContain('lifetime');
  });

  test('team-without-peers gates the peer-only pieces (no event_id target, no scope, no workspace hiring)', () => {
    const deps = withBuildMode({ team: makeTeam().deps });
    expect(agentsActionsFor(deps)).toEqual(['hire', 'msg', 'list', 'dismiss']);
    const t = agentsTool(deps);
    expect(actionEnum({ value: t.inputSchema })).not.toContain('swarm');
    expect(Object.keys(v.parse(v.object({ jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }) }), t.inputSchema).jsonSchema.properties)).not.toContain('event_id');
    expect(renderAgentsToolDescription(deps)).not.toContain('scope=workspace');
  });

  test('an unavailable action is a sharp error, not a deps call', async () => {
    const t = agentsTool({ swarm: swarmDeps() });
    await expect(t.execute({ action: 'hire', role: 'r', mission: 'm' })).rejects.toMatchObject({ code: 'unsupported', message: 'action "hire" is not available here. Available: swarm' });
  });
});

// Unknown fields are refused with a correctable message rather than silently dropped.

describe('agents tool — the field contract', () => {
  const fullDeps = () => withBuildMode({ swarm: swarmDeps(), team: makeTeam().deps, peers: makePeers().deps });

  function propertyNames(input: { value: unknown }): string[] {
    return Object.keys(v.parse(v.object({
      jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }),
    }), input.value).jsonSchema.properties);
  }

  test('a camelCase cap is refused by the tool, naming the field it meant', async () => {
    const t = agentsTool({ swarm: swarmDeps() });

    /* SAFETY: an undeclared field, as reaches `execute` in production (AI SDK checks types, not names). */
    const input: AgentsToolInput & { budgetUsd: number; budgetLabel: string } = {
      action: 'swarm', task: 'explore', budgetUsd: 5, budgetLabel: 'audit',
    };

    const pending = t.execute(input);
    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('unknown field "budgetUsd" — did you mean "budget_usd"?');
    await expect(pending).rejects.toThrow('unknown field "budgetLabel" — did you mean "budget_label"?');
  });

  test('the refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    // A parse refusal must classify as `refused`, not `broke` (read-models/tool-failures.ts).
    const args: AgentsToolInput & { budgetUsd: number } = { action: 'swarm', task: 'explore', budgetUsd: 5 };
    expect(await recordedFailure(agentsTool({ swarm: swarmDeps() }).execute(args), args)).toEqual({
      tool: 'agents', action: 'swarm', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('the correctly spelled call reaches the handler — the refusal is about names, not caps', async () => {
    // Control: snake_case caps pass the name check and hit the missing-`preset` refusal instead.
    const t = agentsTool({ swarm: swarmDeps() });
    const pending = t.execute({ action: 'swarm', task: 'explore', budget_usd: 5, budget_label: 'audit' });
    await expect(pending).rejects.toThrow('swarm needs `preset`');
    await expect(pending).rejects.not.toThrow('unknown field');
  });

  function propertyDescription(input: { value: unknown }, field: string): string {
    const properties = v.parse(v.object({
      jsonSchema: v.object({ properties: v.record(v.string(), v.object({ description: v.string() })) }),
    }), input.value).jsonSchema.properties;

    const property = properties[field];

    if (!property) throw new Error(`the swarm surface advertises no \`${field}\``);

    return property.description;
  }

  test('hire context and swarm config describe inheritance from one source', () => {
    const tool = agentsTool({ team: makeTeam().deps, swarm: swarmDeps(), profile: testProfile });
    expect(propertyDescription({ value: tool.inputSchema }, 'context')).toContain(DELEGATION_CONTEXT_DESCRIPTION);
    expect(propertyDescription({ value: tool.inputSchema }, 'config')).toContain(DELEGATION_CONTEXT_DESCRIPTION);
    expect(parseAgentsToolInput({ input: { action: 'hire', role: 'researcher', mission: 'Read' } }))
      .not.toHaveProperty('context');
    expect(() => parseAgentsToolInput({ input: { action: 'swarm', task: 'Read', context: 'inherit' } })).toThrow('hire');
  });

  test('the preset list reaches the model where `preset` is filled, from the one constant', () => {
    // One constant rendered everywhere the preset list appears, so copies cannot drift.
    const t = agentsTool({ swarm: swarmDeps() });
    const preset = propertyDescription({ value: t.inputSchema }, 'preset');
    expect(preset).toContain(SWARM_PRESET_DOCTRINE.join(' '));

    for (const name of SWARM_PRESETS) expect(preset).toContain(name);
  });

  test('the missing-`preset` refusal names the same presets the property does', async () => {
    await expect(agentsTool({ swarm: swarmDeps() }).execute({ action: 'swarm', task: 'explore' }))
      .rejects.toThrow(SWARM_PRESET_DOCTRINE.join(' '));
  });

  test('the front objective kinds are advertised as pareto-only, not refused', () => {
    // The description must offer the pareto contract, not a blanket refusal of front kinds.
    const objective = propertyDescription({ value: agentsTool({ swarm: swarmDeps() }).inputSchema }, 'objective');
    expect(objective).toContain('run only with advance:"pareto"');
    expect(objective).toContain('{kind:"instanced", metric, unit, direction, scale, target, instances}');
    expect(objective).toContain('{kind:"vector", components:[...]}');
    expect(objective).not.toContain('both are refused today');
    expect(objective).toContain('{kind:"scalar"');
    expect(objective).toContain('kind:"witness" is a checkable certificate');
  });

  test('a cap on an action that cannot spend it is refused, not accepted and ignored', async () => {
    // `budget_usd` is read only by `swarm`; on `hire` it is refused before spawning.
    const team = makeTeam();
    const t = agentsTool({ team: team.deps });
    const pending = t.execute({ action: 'hire', role: 'researcher', mission: 'survey the landscape', budget_usd: 5 });
    await expect(pending).rejects.toThrow('field "budget_usd" does not apply to action "hire"');
    await expect(pending).rejects.toThrow('it is read by swarm');
    await expect(pending).rejects.toThrow('action "hire" takes: role, mission, agent');
    expect(team.calls).toEqual([]);
  });

  test('every advertised property is a field some action reads, and every field is advertised', () => {
    // Under full deps, because the property set is dep-gated; the union must agree with the map.
    const advertised = propertyNames({ value: agentsTool(fullDeps()).inputSchema }).sort();
    const claimed = [...new Set(AGENTS_TOOL_ACTIONS.flatMap((action) => [...AGENTS_ACTION_FIELDS[action]]))];
    expect(advertised).toEqual(['action', ...claimed].sort());
    expect(advertised).not.toContain('timeout_seconds');
    expect(claimed).not.toContain('timeout_seconds');
  });

  test('a dep-gated actor advertises a subset, and never a field no action of its own reads', () => {
    // Non-vacuity: a search-only actor is offered a strict subset.
    const searchOnly = propertyNames({ value: agentsTool({ swarm: swarmDeps() }).inputSchema }).sort();
    expect(searchOnly).toEqual(['action', ...AGENTS_ACTION_FIELDS.swarm].sort());
    expect(searchOnly).not.toContain('agent');
    expect(searchOnly).not.toContain('mission');
  });
});

// Depth cap: primarily enforced by not wiring `team` at the cap; these cover the seam, since a
// ToolSet is cached across turns and a facet's identity is seeded after it is built.

describe('agents tool — delegation depth', () => {
  const depthDeps = (depth: number, extra: Partial<AgentsToolDeps> = {}) => {
    const team = makeTeam();

    return {
      team,
      deps: withBuildMode({ team: { ...team.deps, delegation: delegationBudgetAtDepth(depth) }, profile: () => testProfile(), ...extra }),
    };
  };

  test('depth 4 is reachable and depth 5 is refused, at the boundary', async () => {
    // Depth 3 hire produces depth 4, the deepest allowed.
    const below = depthDeps(3);
    expect(await agentsTool(below.deps).execute({ action: 'hire', role: 'researcher', mission: 'm' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(below.team.calls).toMatchObject([{ action: 'spawn' }]);

    const atCap = depthDeps(4);
    const pending = agentsTool(atCap.deps).execute({ action: 'hire', role: 'researcher', mission: 'm' });
    await expect(pending).rejects.toMatchObject({ code: 'denied' });
    await expect(pending).rejects.toThrow('depth 4');
    await expect(pending).rejects.toThrow('depth 5');
    expect(atCap.team.calls).toEqual([]);
  });

  test('the refusal lands in refused, not in broke', async () => {
    const { deps } = depthDeps(4);
    const args: AgentsToolInput = { action: 'hire', role: 'researcher', mission: 'm' };
    expect(await recordedFailure(agentsTool(deps).execute(args), args)).toMatchObject({ reason: 'denied', refused: true });
  });

  // Minting a workspace would reset depth to 0; `peers` is never wired below the orchestrator.
  test('a subordinate cannot mint a fresh root to escape its own subtree', async () => {
    const { deps, team } = depthDeps(2);
    const pending = agentsTool(deps).execute({ action: 'hire', scope: 'workspace', mission: 'a tree of my own', message: 'go' });
    await expect(pending).rejects.toMatchObject({ code: 'denied' });
    await expect(pending).rejects.toThrow('only the workspace orchestrator');
    expect(team.calls).toEqual([]);
    expect(await agentsTool(deps).execute({ action: 'hire', role: 'researcher', mission: 'm' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
  });

  test('the remaining depth is advertised where head-tools advertises nesting room', () => {
    expect(agentsTool(depthDeps(0).deps).description).toBeTruthy();
    const enumDescription = (depth: number) => actionDescription({ value: agentsTool(depthDeps(depth).deps).inputSchema });
    expect(enumDescription(0)).toContain('3 level(s) further');
    expect(enumDescription(3)).toContain('lands on the depth cap and cannot hire its own');
  });
});

/** Invalid calls are refused (`bad_input`) before the spawn announcement, never as a failed background job. */
describe('agents tool — the swarm refusal seam', () => {

  /** Built here so the extra key is not an excess property on a `ToolExecutionOptions` literal. */
  function spawnAnnouncing(announce: () => void) {
    return { toolCallId: 'tc-swarm', messages: [], [SPAWN_STARTED_OPTION]: announce };
  }

  test('a swarm with no preset is refused at the seam — before the spawn is announced', async () => {
    const tool = agentsTool({ swarm: swarmDeps() });
    let announced = 0;
    const pending = tool.execute({ action: 'swarm', task: 'split the work' }, spawnAnnouncing(() => { announced += 1; }));
    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow(/\bpreset\b/);
    expect(announced).toBe(0);
  });

  test('a swarm with no task is the same refusal, and names where the metric goes', async () => {
    const tool = agentsTool({ swarm: swarmDeps() });
    let announced = 0;
    const pending = tool.execute({ action: 'swarm', preset: 'ideate' }, spawnAnnouncing(() => { announced += 1; }));
    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('`objective`');
    expect(announced).toBe(0);
  });

  test('a swarm refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    const tool = agentsTool({ swarm: swarmDeps() });
    const args: AgentsToolInput = { action: 'swarm', task: 't' };
    expect(await recordedFailure(tool.execute(args), args)).toEqual({
      tool: 'agents', action: 'swarm', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('the task field states what it is for, and what a node can lean on', () => {
    const schema = v.parse(v.object({ jsonSchema: v.object({ properties: v.object({
      task: v.object({ description: v.string() }),
    }) }) }), agentsTool({ swarm: swarmDeps() }).inputSchema);

    const { task } = schema.jsonSchema.properties;
    expect(task.description).toMatch(/what the search is for, in prose/);
    expect(task.description).toMatch(/never the measured quantity/);
    expect(task.description).toContain(DELEGATION_INHERITANCE.swarm.brief);
  });
});

describe('agents tool — subordinate actions', () => {
  test('Plan research children cannot acquire Build file authority from a Build-shaped parent provider', async () => {
    const { rt } = createTestRuntime();
    const path = '/home/user/project.txt';
    await rt.storage.vfs.mkdir('/home/user', { recursive: true });
    await rt.storage.vfs.writeFile(path, 'original');
    const team = makeTeam();

    const childTransport: TeamToolDeps = {
      ...team.deps,
      temporary: {
        ...temporaryPortStub,
        run: async (request) => {
          const tools = buildToolSurface({ rt, workMode: request.mode, history: storesFor(rt).history });
          const file = tools.file;

          if (file === undefined) throw new Error('Child has no file tool');
          const execute = toolExecute(file);
          await execute({ action: 'read', path });
          const pending = execute({ action: 'write', path, content: 'changed' });

          if (request.mode === 'plan') {
            await expect(pending).rejects.toMatchObject({ code: 'denied' });

            return { ...await temporaryPortStub.run(), answer: 'denied' };
          }

          return { ...await temporaryPortStub.run(), answer: JSON.stringify(await pending) };
        },
      },
    };

    const parent = agentsTool({ mode: 'build', team: childTransport, profile: () => testProfile() });
    const planned = await inWorkMode('plan', () => parent.execute({ action: 'hire', lifetime: 'task', role: 'researcher', mission: 'Inspect' }));
    expect(planned).toMatchObject({ status: 'completed', answer: expect.stringContaining('denied') });
    expect(await rt.storage.vfs.readFile(path, { encoding: 'utf8' })).toBe('original');
    await expect(inWorkMode('plan', () => parent.execute({ action: 'hire', role: 'researcher', mission: 'Create a permanent worker' })))
      .rejects.toMatchObject({ code: 'denied' });
    await parent.execute({ action: 'hire', lifetime: 'task', role: 'researcher', mission: 'Implement' });
    expect(await rt.storage.vfs.readFile(path, { encoding: 'utf8' })).toBe('changed');
  });

  test('hire forwards role/mission (+ optional agent name/tier) to team.spawn', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: () => testProfile() });

    const result = await t.execute({
      action: 'hire', agent: 'scout', role: 'researcher', mission: 'Map the landscape',
    });

    expect(result).toEqual({ name: 'scout', displayName: 'Researcher' });
    expect(calls[0].input).toEqual({
      name: 'scout', role: 'researcher', mission: 'Map the landscape', mode: 'build',
    });
  });

  test('a hire at either lifetime refuses without a catalog', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });
    await expect(t.execute({ action: 'hire', role: 'researcher', mission: 'Map the landscape' })).rejects.toMatchObject({ code: 'denied' });
    await expect(t.execute({ action: 'hire', lifetime: 'task', role: 'researcher', mission: 'Survey auth' })).rejects.toMatchObject({ code: 'denied' });
  });


  test('a hire naming a roster name assigns the work and says the report arrives as an event', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = v.parse(WorkingResultSchema, await t.execute({
      action: 'hire', agent: 'researcher', message: 'Survey auth', deliverable: 'a note',
    }));

    expect(result.status).toBe('working');
    expect(result.agent).toBe('researcher');
    expect(result.note).toContain('event');
    expect(calls[0]).toEqual({
      action: 'assign',
      input: { name: 'researcher', task: 'Survey auth', deliverable: 'a note', mode: 'build' },
    });
  });

  // Create-only fields on an existing agent are refused by name.
  test('a hire to an existing agent refuses create-only fields by name', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: () => testProfile() });
    await expect(t.execute({ action: 'hire', agent: 'researcher', message: 'Survey auth', mission: 'Map it' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'field "mission" is not available on a hire that names an existing agent — its brief is `message`' });
    await expect(t.execute({ action: 'hire', agent: 'researcher', message: 'Survey auth', tier: 'deep' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'field "tier" is not available on a hire that names an existing agent — it already runs at its own tier' });
    await expect(t.execute({ action: 'hire', agent: 'researcher', message: 'Survey auth', lifetime: 'task' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'field "lifetime" is not available on a hire that names an existing agent — it already has one; `lifetime` belongs to a hire that creates with `role`' });
    expect(calls).toEqual([]);
  });

  test('a lifetime:"task" hire refuses tier and runs at its role tier', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: () => testProfile() });
    await expect(t.execute({ action: 'hire', lifetime: 'task', role: 'researcher', mission: 'Survey auth', tier: 'deep' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'field "tier" is not available on a lifetime:"task" hire — it runs at its role\'s tier; omit it, or hire `durable` for an override' });
    expect(calls).toEqual([]);
  });

  test('a hire that creates refuses the existing-agent fields by name', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: () => testProfile() });
    await expect(t.execute({ action: 'hire', role: 'researcher', mission: 'Map it', deliverable: 'a note' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'field "deliverable" is not available on a hire that creates an agent — say what the result should be in `mission`' });
    await expect(t.execute({ action: 'hire', role: 'researcher', mission: 'Map it', topic: 'auth' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'field "topic" is not available on a hire that creates an agent — it labels a message to an agent that already exists' });
    expect(calls).toEqual([]);
  });

  test('a hire to an existing agent reports the event id, how the work lands, and what the subordinate was doing', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = v.parse(
      HandoffResultSchema,
      await t.execute({ action: 'hire', agent: 'researcher', message: 'Survey auth' }),
    );

    expect(result.event_id).toBe('evt-queued');
    expect(result.delivery).toBe('queued');
    expect(result.subordinate_phase).toEqual({ busy: true, lastActivityAt: 1234, workingOn: 'reading src/auth.ts' });
    expect(result.note).toContain('own turn');
    expect(result.note).toContain('evt-queued');
  });

  const hires = [
    { name: 'a hire against an idle subordinate says the work starts now',
      delivery: 'starts_now', busy: false, note: 'idle' },
    { name: 'a hire deduped against work already waiting says so instead of claiming a fresh start',
      delivery: 'queued', busy: true, note: 'Queued behind' },
  ] as const;

  for (const hire of hires) {
    test(hire.name, async () => {
      const { deps } = makeTeam({
        assign: async (input) => ({ ok: true, name: input.name, ...handoff(hire.delivery, hire.busy) }),
      });

      const t = agentsTool({ team: deps });

      const result = v.parse(
        DeliveryNoteSchema,
        await t.execute({ action: 'hire', agent: 'researcher', message: 'x' }),
      );

      expect(result.delivery).toBe(hire.delivery);
      expect(result.note).toContain(hire.note);
    });
  }

  test('msg to a roster name injects a conversational note', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({ action: 'msg', agent: 'researcher', message: 'also check the CLI' });
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

  test('msg uses the same delivered/queued vocabulary as the peer transport', async () => {
    const delivered = agentsTool({ team: makeTeam({
      message: async (input) => ({ ok: true, name: input.name, ...handoff('starts_now', false) }),
    }).deps });

    const backlogged = agentsTool({ team: makeTeam({
      message: async (input) => ({ ok: true, name: input.name, ...handoff('queued', true) }),
    }).deps });

    expect(await delivered.execute({ action: 'msg', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'delivered', delivery: 'starts_now' });
    expect(await backlogged.execute({ action: 'msg', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'queued', delivery: 'queued' });
  });

  test('a COMPLETED (idle) subordinate still answers a follow-up hire — persistence is the semantic', async () => {
    // 'idle' is the post-completion state; it must stay addressable.
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = v.parse(
      v.object({ status: v.string() }),
      await t.execute({ action: 'hire', agent: 'researcher', message: 'one more thing' }),
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

  test('missing required args are sharp refusals, classified bad_input — not deps calls, not defects', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    await expect(t.execute({ action: 'hire', role: 'r' })).rejects.toMatchObject({ code: 'bad_input', message: 'hire requires role and mission' });
    await expect(t.execute({ action: 'hire', agent: 'x' })).rejects.toMatchObject({ code: 'bad_input', message: 'hire requires a target and a brief: `role` with `mission` to create an agent, or `agent` with `message` to hand the workstream to one that exists.' });
    await expect(t.execute({ action: 'msg', agent: 'x' })).rejects.toMatchObject({ code: 'bad_input', message: 'msg requires a message' });
    await expect(t.execute({ action: 'dismiss' })).rejects.toMatchObject({ code: 'bad_input', message: 'dismiss requires agent' });
    expect(calls).toEqual([]);
  });

  test('a peers-only actor that asks to hire a SUBORDINATE is denied, not indicted', async () => {
    // A peers-only actor can name the subordinate scope; that must classify as `refused`.
    const t = agentsTool({ peers: makePeers().deps });
    await expect(t.execute({ action: 'hire', role: 'r', mission: 'm' })).rejects.toMatchObject({ code: 'denied', message: 'hiring subordinates is not available on this actor' });
  });

  test('a name on neither roster is a caller mistake, not an unknown transport state', async () => {
    const t = agentsTool({ team: makeTeam().deps });
    await expect(t.execute({ action: 'hire', agent: 'ghost', message: 'x' })).rejects.toMatchObject({ code: 'bad_input', message: 'unknown agent "ghost" — check the roster with action:"list"' });
    await expect(t.execute({ action: 'msg', agent: 'ghost', message: 'x' })).rejects.toMatchObject({ code: 'bad_input', message: 'unknown agent "ghost" — check the roster with action:"list"' });
  });

  test('deps exceptions surface as tool error objects (never throw into the turn)', async () => {
    const { deps } = makeTeam({
      assign: async () => { throw new Error('subordinate "researcher" is dismissed'); },
    });

    const t = agentsTool({ team: deps });
    await expect(t.execute({ action: 'hire', agent: 'researcher', message: 'x' })).rejects.toThrow('dismissed');
  });
});

describe('agents tool — peer workspace actions', () => {
  test('a hire naming a non-roster agent routes to the peer transport and returns the reply', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const t = agentsTool({ team: team.deps, peers: peers.deps });
    const result = await t.execute({ action: 'hire', agent: 'scout', message: 'What changed?', topic: 'research' });
    expect(result).toEqual({ status: 'replied', from: 'scout', reply: 'answer' });
    expect(peers.calls[0].input).toMatchObject({ agent: 'scout', topic: 'research', message: 'What changed?', mode: 'build' });
    expect(team.calls).toEqual([]);
  });

  test('a subordinate name wins an addressing collision with a peer', async () => {
    const team = makeTeam();
    const peers = makePeers({ listPeers: async () => [{ name: 'researcher' }] });
    const t = agentsTool({ team: team.deps, peers: peers.deps });
    await t.execute({ action: 'hire', agent: 'researcher', message: 'x' });
    expect(team.calls[0]?.action).toBe('assign');
    expect(peers.calls).toEqual([]);
  });

  test('a peer hire has no elapsed deadline and refuses the retired field', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await t.execute({ action: 'hire', agent: 'scout', message: 'x' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      agent: 'scout', topic: 'message', message: 'x', mode: 'build',
    });
    expect('timeoutMs' in (calls[0]?.input ?? {})).toBe(false);

    expect(() => parseAgentsToolInput({
      input: { action: 'hire', agent: 'scout', message: 'x', timeout_seconds: 1 },
    })).toThrow('unknown field "timeout_seconds"');
    expect(calls).toHaveLength(1);
  });

  test('msg by agent is fire-and-forget; msg by event_id answers that event', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    expect(await t.execute({ action: 'msg', agent: 'scout', message: 'FYI' }))
      .toEqual({ status: 'delivered', message_id: 'ox1' });
    expect(await t.execute({ action: 'msg', event_id: 'pe1', message: 'here you go' })).toEqual({ ok: true });
    expect(calls[1].input).toEqual({ eventId: 'pe1', message: 'here you go' });
  });

  test('msg naming both targets is refused, naming the fix for each intent', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await expect(t.execute({ action: 'msg', agent: 'scout', event_id: 'pe1', message: 'x' }))
      .rejects.toMatchObject({
        code: 'bad_input',
        message: 'msg takes ONE target: `agent` to name an agent, or `event_id` to answer the agent '
          + 'message event you were given. Naming both leaves it undecided who this is for — '
          + 'drop `event_id` to message the named agent, or drop `agent` to answer that event.',
      });
    await expect(t.execute({ action: 'msg', message: 'x' }))
      .rejects.toMatchObject({
        code: 'bad_input',
        message: 'msg requires a target: `agent` to name an agent, or `event_id` to answer the agent message event you were given.',
      });
    expect(calls).toEqual([]);
  });

  test('hire scope=workspace forwards mission as purpose + message (the old spawn_workspace, verbatim transport)', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });

    const result = await t.execute({
      action: 'hire', scope: 'workspace', mission: 'summarize research papers', message: 'Summarize X',
    });

    expect(result).toMatchObject({ agent: 'specialist', created: true, status: 'replied' });
    expect(calls[0].input).toEqual({
      purpose: 'summarize research papers', message: 'Summarize X', mode: 'build',
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
    await expect(t.execute({ action: 'hire', agent: 'scout' })).rejects.toMatchObject({ code: 'bad_input', message: 'hire requires agent and message' });
    await expect(t.execute({ action: 'msg', agent: 'scout' })).rejects.toMatchObject({ code: 'bad_input', message: 'msg requires a message' });
    await expect(t.execute({ action: 'hire', scope: 'workspace', message: 'x' })).rejects.toMatchObject({ code: 'bad_input', message: 'hire scope=workspace requires mission and message' });
    expect(calls).toEqual([]);
  });

  test(`the reserved "${PEER_REPLY_TOPIC}" topic is rejected`, async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await expect(t.execute({ action: 'msg', agent: 'scout', message: 'x', topic: PEER_REPLY_TOPIC }))
      .rejects.toThrow('reserved');
    expect(calls).toEqual([]);
  });
});

// Stored rows are re-driven, not answered, so the filter translates rather than refuses and
// names what it dropped. It is also the detach gate (orchestrator/background-tools.ts).

describe('agents tool — resuming a stored delegation row', () => {
  /** `diagnostics` writes JSON lines to console.error with no injection seam; see unit-mcts-resume.test.ts. */
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
    // Also the detach gate: non-null here is what lets a live search detach.
    expect(resumableAgentsInput('agents', {
      action: 'swarm', preset: 'optimise', task: 'search', depth: 3, budget_usd: 5,
    })).toEqual({ action: 'swarm', preset: 'optimise', task: 'search', depth: 3, budget_usd: 5 });
  });

  test('a stored fork row is re-driven as the action that spawns nodes today', () => {
    // A stored fork maps onto `preset:'ideate'` (no `objective` to invent); caps carry over.
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'fork', task: 'search', forks: twoForks, merge_strategy: 'consensus', budget_usd: 5,
    }));

    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search', budget_usd: 5 });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('forks');
    expect(dropped[0]).toContain('merge_strategy');
    expect(dropped[0]).toContain('settlement');
    expect(dropped[0]).not.toContain('budget_usd');
  });

  test('a stored settle row takes the same translation, from one era further back', () => {
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'fork', task: 'search', settle: 'mcts', budget_tokens: 900,
    }));

    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search', budget_tokens: 900 });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('settle');
    expect(dropped[0]).toContain('settlement');
  });

  test('a stored inherit-context row resumes under the renamed value', () => {
    // `context:'fork'` is rewritten before the parse, which refuses the old spelling.
    const { result: resumed } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'swarm', preset: 'custom', task: 'search', config: { context: 'fork' },
    }));

    expect(resumed).toEqual({ action: 'swarm', preset: 'custom', task: 'search', config: { context: 'inherit' } });
  });

  test('a row carrying a field the parse now refuses still resumes, and the drop is logged', () => {
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'swarm', preset: 'ideate', task: 'search', budgetUsd: 5,
    }));

    // `budgetUsd` never applied originally, so dropping it reproduces that run.
    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search' });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('budgetUsd');
  });

  test('a stored field the target action does not read is narrowed away, so the re-drive is not refused', async () => {
    // `topic` is declared, so a lenient parse keeps it and the strict tool parse would refuse the row;
    // the filter builds the call from the target action's fields only.
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      action: 'swarm', preset: 'ideate', task: 'search', topic: 'stale',
    }));

    expect(resumed).toEqual({ action: 'swarm', preset: 'ideate', task: 'search' });
    expect(lines.filter((line) => line.includes('agents.resume.fields_dropped'))).toHaveLength(1);

    if (!resumed) throw new Error('expected a resumable agents input');
    const replayed = v.parse(v.record(v.string(), v.unknown()), await agentsTool({ swarm: swarmDeps() }).execute(resumed));
    expect(replayed['reason']).toBeUndefined();
    expect(replayed['error']).toBeUndefined();
    expect(replayed['report']).toBeDefined();
  });

  test('a stored row for a converse action is not resumable, and neither is another tool', () => {
    expect(resumableAgentsInput('agents', { action: 'hire', role: 'r', mission: 'm' })).toBeNull();
    expect(resumableAgentsInput('agents', { action: 'ask', agent: 'a', message: 'm' })).toBeNull();
    expect(resumableAgentsInput('shell', { command: 'ls' })).toBeNull();
  });
});

