import { readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// Tool-side contract of the unified `agents` tool; transports are covered in cf-backend tests.
import { describe, test, expect } from 'bun:test';
import { createTestRuntime, toolExecute, scriptedTurnModel, unobservedSearchSeams } from '@kinu.run/test-utils';
import { swarmSeats } from './helpers-actor-host';

import * as v from 'valibot';
import { delegationChoices } from '../src/delegation/agents-tool';
import { AGENTS_OPS } from '../src/operations/agents';
import { SWARM_PRESETS } from '../src/strategy/swarm';
import {
  agentsActionsFor, buildBuiltinTools, createAgentsTool, resumableAgentsInput,
  deriveChildDelegationBudget, ROOT_DELEGATION_BUDGET,
  PEER_REPLY_TOPIC, SPAWN_STARTED_OPTION,
  classifyToolFailure, JsonObjectSchema, failedToolOutcome,
  type AgentsSwarmDeps, type AgentsToolDeps,
  type AgentsProfileContext,
  type TeamToolDeps,
  BUILTIN_PROFILE_CATALOG, BUILTIN_ROLE_DEFINITIONS, profileCatalogDigest, DEFAULT_WORKERS_AI_MODEL_SPEC, validateProfileCatalog,
  type ProfileCatalog,
} from '../src/index';
import { renderThrownChain } from '../src/obs/index';
import { inWorkMode } from '../src/execution/work-mode';
import { buildToolSurface } from '../src/tools/builtins';
import { conversationsFor } from './helpers';
import { handoff, makeTeam, makePeers, rosterEntry, temporaryPortStub } from './helpers-agents';
import type { JsonObject } from '../src/utils/json';

/** A call to the native `agents` tool: its `op` and that operation's fields. */
type AgentsCall = JsonObject;

async function recordedFailure(pending: Promise<AgentsTestResult>, args: AgentsCall) {
  try { await pending; }
  catch (cause) {
    return classifyToolFailure({ type: 'tool_call_end', eventIndex: 0, runId: 'run-1',
      timestamp: new Date().toISOString(), name: 'agents', toolCallId: 'tc-1',
      args: v.parse(JsonObjectSchema, args), error: renderThrownChain({ cause }), outcome: failedToolOutcome({ cause }) });
  }

  throw new Error('the native agents invocation did not fail');
}

type AgentsTestResult = object | string | number | boolean | null | undefined;

/** `swarms` defaults on: these suites pin the tool as it stands with "Beta: swarms" turned on. */
type TestAgentsToolDeps = Omit<AgentsToolDeps, 'mode' | 'swarms'> & Partial<Pick<AgentsToolDeps, 'mode' | 'swarms'>>;

function testProfile(catalog: ProfileCatalog = {
  roles: BUILTIN_PROFILE_CATALOG.roles,
  tiers: {
    default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC },
    fast: { model: DEFAULT_WORKERS_AI_MODEL_SPEC },
    deep: { model: DEFAULT_WORKERS_AI_MODEL_SPEC },
  },
}): AgentsProfileContext {

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
    pins: {},
  };
}

function withBuildMode(deps: TestAgentsToolDeps): AgentsToolDeps {
  return { mode: 'build', swarms: true, ...deps };
}

function agentsTool(deps: TestAgentsToolDeps) {
  const entry = createAgentsTool(withBuildMode(deps));

  if (!entry) throw new Error('Expected agents tool to be created');

  return { ...entry, execute: toolExecute<AgentsCall, AgentsTestResult>(entry) };
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
    rt, ...swarmSeats({ rt, db: testSql.db }, () => testModel),
    ...unobservedSearchSeams(),
    ...overrides,
  };
}

/** The operations the native tool offers. */
function opsOf(input: { value: unknown }): string[] {
  return v.parse(v.object({
    jsonSchema: v.object({
      properties: v.object({ op: v.object({ enum: v.array(v.string()) }) }),
    }),
  }), input.value).jsonSchema.properties.op.enum;
}

/** The native tool's input properties. */
function propertyNames(input: { value: unknown }): string[] {
  return Object.keys(v.parse(v.object({
    jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }),
  }), input.value).jsonSchema.properties);
}

describe('agents tool — registration and dep-gating', () => {
  test('a new helper takes its birth context; an existing agent is refused one', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: testProfile });

    await expect(t.execute({ op: 'assign', agent: 'researcher', message: 'Continue', context: 'inherit' }))
      .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('unknown field "context"') });
    expect(calls).toEqual([]);
  });

  test('no deps groups → no agents tool at all', () => {
    const { rt } = createTestRuntime();
    const tools = buildBuiltinTools({ rt, conversations: conversationsFor(rt) });
    expect(Object.keys(tools)).not.toContain('agents');
  });

  test('the exploration substrate (the CLI / subordinate surface) offers the search alone', () => {
    const deps = withBuildMode({ swarm: swarmDeps() });
    expect(agentsActionsFor(deps)).toEqual(['swarm']);
    expect(opsOf({ value: agentsTool(deps).inputSchema })).toEqual(['swarm']);
  });

  test('full deps (the workspace orchestrator) offer every operation', () => {
    const deps = withBuildMode({ swarm: swarmDeps(), team: makeTeam().deps, peers: makePeers().deps });
    expect(opsOf({ value: agentsTool(deps).inputSchema })).toEqual([...AGENTS_OPS]);
  });

  test('with "Beta: swarms" off the tool offers no swarm, in its schema or its words, and refuses one', async () => {
    const t = agentsTool({ swarm: swarmDeps(), swarms: false, team: makeTeam().deps, peers: makePeers().deps });

    expect(opsOf({ value: t.inputSchema })).toEqual(AGENTS_OPS.filter((op) => op !== 'swarm'));
    expect(JSON.stringify({ description: t.description, schema: t.inputSchema })).not.toContain('preset');
    await expect(t.execute({ op: 'swarm', task: 'rank the three caching designs', preset: 'ideate' }))
      .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('unknown op "swarm"') });
  });

  test('with it off, two accounts\' tools are byte-identical, whatever roles and tiers their catalogs hold', () => {
    const bytes = (catalog: ProfileCatalog) => {
      const t = agentsTool({ swarm: swarmDeps(), swarms: false, team: makeTeam().deps, profile: () => testProfile(catalog) });

      return JSON.stringify({ description: t.description, schema: t.inputSchema });
    };

    // Two validated catalogs: one account adds a role and a tier the other has not.
    const plain = validateProfileCatalog({ value: { roles: BUILTIN_PROFILE_CATALOG.roles, tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } } } });

    const own = validateProfileCatalog({ value: {
      roles: { reviewer: { ...BUILTIN_ROLE_DEFINITIONS.task, label: 'Reviewer', description: 'Reviews pull requests.' } },
      tiers: { default: { model: DEFAULT_WORKERS_AI_MODEL_SPEC }, careful: { model: DEFAULT_WORKERS_AI_MODEL_SPEC } },
    } });

    expect(bytes(own)).toBe(bytes(plain));
    // What they differ in reaches each actor's step context instead.
    expect(delegationChoices(testProfile(own))).toMatchObject({ roles: expect.arrayContaining(['reviewer: Reviews pull requests.']), tiers: expect.arrayContaining(['careful']) });
  });

  test('the task lifetime is offered only where the actor can run one', () => {
    const temporaryCapable = agentsTool({ team: makeTeam().deps });
    const durableOnly = agentsTool({ team: { ...makeTeam().deps, temporary: undefined } });

    expect(propertyNames({ value: temporaryCapable.inputSchema })).toContain('lifetime');
    expect(propertyNames({ value: durableOnly.inputSchema })).not.toContain('lifetime');
    expect(JSON.stringify(durableOnly)).not.toMatch(/lifetime|"task"/u);
  });

  test('team-without-peers offers no peer-only operation or field', () => {
    const t = agentsTool({ team: makeTeam().deps });
    expect(opsOf({ value: t.inputSchema })).toEqual(['hire', 'assign', 'message', 'list', 'dismiss']);
    expect(propertyNames({ value: t.inputSchema })).not.toContain('eventId');
    expect(JSON.stringify({ description: t.description, schema: t.inputSchema })).not.toMatch(/workspace hire|eventId|topic/u);
  });

  test('an operation this actor is not wired for is refused, naming the ones it has', async () => {
    const t = agentsTool({ swarm: swarmDeps() });
    await expect(t.execute({ op: 'hire', role: 'r', mission: 'm' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'unknown op "hire"; the ops are: swarm' });
  });
});

describe('agents tool — the field contract', () => {
  test('a cap spelled the engine\'s way is refused, naming the operation\'s fields', async () => {
    const pending = agentsTool({ swarm: swarmDeps() }).execute({ op: 'swarm', task: 'explore', budget_usd: 5 });
    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow('unknown field "budget_usd"');
    await expect(pending).rejects.toThrow('budgetUsd');
  });

  test('the refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    // A parse refusal must classify as `refused`, not `broke` (read-models/tool-failures.ts).
    const args = { op: 'swarm', task: 'explore', budget_usd: 5 } satisfies AgentsCall;
    expect(await recordedFailure(agentsTool({ swarm: swarmDeps() }).execute(args), args)).toEqual({
      tool: 'agents', op: 'swarm', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

  test('the correctly spelled call reaches the handler — the refusal is about names, not caps', async () => {
    const pending = agentsTool({ swarm: swarmDeps() }).execute({ op: 'swarm', task: 'explore', budgetUsd: 5, budgetLabel: 'audit' });
    await expect(pending).rejects.toThrow('swarm needs `preset`');
    await expect(pending).rejects.not.toThrow('unknown field');
  });

  test('a swarm refuses a hire\'s `context`', async () => {
    await expect(agentsTool({ swarm: swarmDeps() }).execute({ op: 'swarm', task: 'Read', context: 'inherit' }))
      .rejects.toThrow('unknown field "context"');
  });

  test('the `preset` field names every preset', () => {
    const preset = JSON.stringify(v.parse(v.object({ jsonSchema: v.object({ properties: v.object({ preset: v.unknown() }) }) }),
      agentsTool({ swarm: swarmDeps() }).inputSchema).jsonSchema.properties.preset);

    for (const name of SWARM_PRESETS) expect(preset).toContain(name);
  });

  test('the missing-`preset` refusal names every preset', async () => {
    const pending = agentsTool({ swarm: swarmDeps() }).execute({ op: 'swarm', task: 'explore' });

    for (const name of SWARM_PRESETS) await expect(pending).rejects.toThrow(name);
  });

  test('a cap on an operation that cannot spend it is refused, not accepted and ignored', async () => {
    const team = makeTeam();
    const pending = agentsTool({ team: team.deps }).execute({ op: 'hire', role: 'researcher', mission: 'survey the landscape', budgetUsd: 5 });
    await expect(pending).rejects.toThrow('unknown field "budgetUsd"');
    expect(team.calls).toEqual([]);
  });
});

// Depth cap: primarily enforced by not wiring `team` at the cap; these cover the seam, since a
// ToolSet is cached across turns and a facet's identity is seeded after it is built.

/** A hire chain `depth` levels below the root. */
const budgetAt = (depth: number) =>
  Array.from({ length: depth }, () => 0).reduce((budget) => deriveChildDelegationBudget(budget), ROOT_DELEGATION_BUDGET);

describe('agents tool — delegation depth', () => {
  const depthDeps = (depth: number, extra: Partial<AgentsToolDeps> = {}) => {
    const team = makeTeam();

    return {
      team,
      deps: withBuildMode({ team: { ...team.deps, delegation: budgetAt(depth) }, profile: () => testProfile(), ...extra }),
    };
  };

  test('depth 4 is reachable and depth 5 is refused, at the boundary', async () => {
    // Depth 3 hire produces depth 4, the deepest allowed.
    const below = depthDeps(3);
    expect(await agentsTool(below.deps).execute({ op: 'hire', role: 'researcher', mission: 'm' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
    expect(below.team.calls).toMatchObject([{ action: 'spawn' }]);

    const atCap = depthDeps(4);
    const pending = agentsTool(atCap.deps).execute({ op: 'hire', role: 'researcher', mission: 'm' });
    await expect(pending).rejects.toMatchObject({ code: 'denied' });
    await expect(pending).rejects.toThrow('depth 4');
    await expect(pending).rejects.toThrow('depth 5');
    expect(atCap.team.calls).toEqual([]);
  });

  test('the refusal lands in refused, not in broke', async () => {
    const { deps } = depthDeps(4);
    const args = { op: 'hire', role: 'researcher', mission: 'm' } satisfies AgentsCall;
    expect(await recordedFailure(agentsTool(deps).execute(args), args)).toMatchObject({ reason: 'denied', refused: true });
  });

  // Minting a workspace would reset depth to 0; `peers` is never wired below the orchestrator, so a subordinate is not offered it.
  test('a subordinate cannot mint a fresh root to escape its own subtree', async () => {
    const { deps, team } = depthDeps(2);
    const pending = agentsTool(deps).execute({ op: 'hireWorkspace', mission: 'a tree of my own', message: 'go' });
    await expect(pending).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('unknown op "hireWorkspace"') });
    expect(team.calls).toEqual([]);
    expect(await agentsTool(deps).execute({ op: 'hire', role: 'researcher', mission: 'm' }))
      .toEqual({ name: 'researcher', displayName: 'Researcher' });
  });

  test('the remaining depth is said with hire, as head-tools says nesting room', () => {
    const said = (depth: number) => agentsTool(depthDeps(depth).deps).description;
    expect(said(0)).toContain('3 level(s) further');
    expect(said(3)).not.toContain('level(s) further');
  });
});

/** Invalid calls are refused (`bad_input`) before the spawn announcement, never as a failed background job. */
describe('agents tool — the swarm refusal seam', () => {

  /** Built here so the extra key is not an excess property on a `ToolExecutionOptions` literal. */
  function spawnAnnouncing(announce: () => void) {
    return { toolCallId: 'tc-swarm', messages: [], context: undefined, [SPAWN_STARTED_OPTION]: announce };
  }

  test('a swarm with no preset is refused at the seam — before the spawn is announced', async () => {
    const tool = agentsTool({ swarm: swarmDeps() });
    let announced = 0;
    const pending = tool.execute({ op: 'swarm', task: 'split the work' }, spawnAnnouncing(() => { announced += 1; }));
    await expect(pending).rejects.toMatchObject({ code: 'bad_input' });
    await expect(pending).rejects.toThrow(/\bpreset\b/);
    expect(announced).toBe(0);
  });

  test('a swarm with no task is the same refusal, and its fields say where the metric goes', async () => {
    const tool = agentsTool({ swarm: swarmDeps() });
    let announced = 0;
    const pending = tool.execute({ op: 'swarm', preset: 'ideate' }, spawnAnnouncing(() => { announced += 1; }));
    await expect(pending).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('"task" is required') });
    expect(JSON.stringify(tool.inputSchema)).toContain('The measured quantity goes in `objective`');
    expect(announced).toBe(0);
  });

  test('a swarm refusal counts as the tool DECLINING, not as the tool breaking', async () => {
    const tool = agentsTool({ swarm: swarmDeps() });
    const args = { op: 'swarm', task: 't' } satisfies AgentsCall;
    expect(await recordedFailure(tool.execute(args), args)).toEqual({
      tool: 'agents', op: 'swarm', reason: 'bad_input',
      refused: true, workFailed: false, runtimeMissing: false,
    });
  });

});

describe('agents tool — subordinate actions', () => {
  test('Plan research children cannot acquire Build file authority from a Build-shaped parent provider', async () => {
    const { rt } = createTestRuntime();
    const path = '/home/main/project.txt';
    await rt.storage.vfs.mkdir('/home/main', { recursive: true });
    await writeText(rt.storage.vfs, path, 'original');
    const team = makeTeam();

    const childTransport: TeamToolDeps = {
      ...team.deps,
      temporary: {
        ...temporaryPortStub,
        start: async (request) => {
          const tools = buildToolSurface({ rt, workMode: request.mode, conversations: conversationsFor(rt) });
          const file = tools.file;

          if (file === undefined) throw new Error('Child has no file tool');
          const execute = toolExecute(file);
          await execute({ op: 'read', path });
          const pending = execute({ op: 'write', path, content: 'changed' });

          if (request.mode === 'plan') {
            await expect(pending).rejects.toMatchObject({ code: 'denied' });

            return { ...await temporaryPortStub.start(), answer: 'denied' };
          }

          return { ...await temporaryPortStub.start(), answer: JSON.stringify(await pending) };
        },
      },
    };

    const parent = agentsTool({ mode: 'build', team: childTransport, profile: () => testProfile() });
    const planned = await inWorkMode('plan', () => parent.execute({ op: 'hire', lifetime: 'task', role: 'researcher', mission: 'Inspect' }));
    expect(planned).toMatchObject({ status: 'working', answer: expect.stringContaining('denied') });
    expect(await readText(rt.storage.vfs, path)).toBe('original');
    await expect(inWorkMode('plan', () => parent.execute({ op: 'hire', role: 'researcher', mission: 'Create a permanent worker' })))
      .rejects.toMatchObject({ code: 'denied' });
    await parent.execute({ op: 'hire', lifetime: 'task', role: 'researcher', mission: 'Implement' });
    expect(await readText(rt.storage.vfs, path)).toBe('changed');
  });

  test('hire forwards role/mission (+ optional agent name/tier) to team.spawn', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: () => testProfile() });

    const result = await t.execute({
      op: 'hire', name: 'scout', role: 'researcher', mission: 'Map the landscape',
    });

    expect(result).toEqual({ name: 'scout', displayName: 'Researcher' });
    expect(calls[0].input).toEqual({
      name: 'scout', role: 'researcher', mission: 'Map the landscape', mode: 'build',
    });
  });

  test('a hire at either lifetime refuses without a catalog', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });
    await expect(t.execute({ op: 'hire', role: 'researcher', mission: 'Map the landscape' })).rejects.toMatchObject({ code: 'denied' });
    await expect(t.execute({ op: 'hire', lifetime: 'task', role: 'researcher', mission: 'Survey auth' })).rejects.toMatchObject({ code: 'denied' });
  });


  test('a hire naming a roster name assigns the work and says the report arrives as an event', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = v.parse(WorkingResultSchema, await t.execute({
      op: 'assign', agent: 'researcher', message: 'Survey auth', deliverable: 'a note',
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

    for (const [field, value] of [['mission', 'Map it'], ['tier', 'deep'], ['lifetime', 'task']] as const) {
      await expect(t.execute({ op: 'assign', agent: 'researcher', message: 'Survey auth', [field]: value })).rejects.toMatchObject({
        code: 'bad_input', message: `agents.assign: unknown field "${field}". It takes: agent, message, deliverable.`,
      });
    }

    expect(calls).toEqual([]);
  });

  test('a lifetime:"task" hire refuses tier and runs at its role tier', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: () => testProfile() });
    await expect(t.execute({ op: 'hire', lifetime: 'task', role: 'researcher', mission: 'Survey auth', tier: 'deep' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'field "tier" is not available on a lifetime:"task" hire: it runs at its role\'s tier; omit it, or hire `durable` for an override' });
    expect(calls).toEqual([]);
  });

  test('a hire that creates refuses the existing-agent fields by name', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps, profile: () => testProfile() });

    for (const field of ['deliverable', 'topic']) {
      await expect(t.execute({ op: 'hire', role: 'researcher', mission: 'Map it', [field]: 'x' }))
        .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining(`unknown field "${field}"`) });
    }

    expect(calls).toEqual([]);
  });

  test('a hire to an existing agent reports the event id, how the work lands, and what the subordinate was doing', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = v.parse(
      HandoffResultSchema,
      await t.execute({ op: 'assign', agent: 'researcher', message: 'Survey auth' }),
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
        await t.execute({ op: 'assign', agent: 'researcher', message: 'x' }),
      );

      expect(result.delivery).toBe(hire.delivery);
      expect(result.note).toContain(hire.note);
    });
  }

  test('msg to a roster name injects a conversational note', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({ op: 'message', agent: 'researcher', message: 'also check the CLI' });
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

    expect(await delivered.execute({ op: 'message', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'delivered', delivery: 'starts_now' });
    expect(await backlogged.execute({ op: 'message', agent: 'researcher', message: 'x' }))
      .toMatchObject({ status: 'queued', delivery: 'queued' });
  });

  test('a COMPLETED (idle) subordinate still answers a follow-up hire — persistence is the semantic', async () => {
    // 'idle' is the post-completion state; it must stay addressable.
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });

    const result = v.parse(
      v.object({ status: v.string() }),
      await t.execute({ op: 'assign', agent: 'researcher', message: 'one more thing' }),
    );

    expect(result.status).toBe('working');
    expect(calls[0].action).toBe('assign');
  });

  test('list returns the unified roster; empty roster hints hire', async () => {
    const { deps } = makeTeam();
    const t = agentsTool({ team: deps });
    expect(await t.execute({ op: 'list' })).toEqual({ subordinates: [rosterEntry] });

    const empty = agentsTool({ team: makeTeam({ list: async () => [] }).deps });

    const emptyResult = v.parse(v.object({
      subordinates: v.array(v.unknown()), note: v.optional(v.string()),
    }), await empty.execute({ op: 'list' }));

    expect(emptyResult.subordinates).toEqual([]);
    expect(emptyResult.note).toContain('hire');
  });

  test('list with a subordinate name returns its live status view', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    const result = await t.execute({ op: 'list', agent: 'researcher' });
    expect(result).toEqual({ roster: [rosterEntry] });
    expect(calls[0]).toEqual({ action: 'status', input: { name: 'researcher' } });
  });

  test('dismiss ARCHIVES by default — context kept unless keep_history is explicitly false', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });
    expect(await t.execute({ op: 'dismiss', agent: 'researcher' }))
      .toEqual({ ok: true, name: 'researcher', historyKept: true, stoppedJobs: [] });
    expect(calls[0].input).toEqual({ name: 'researcher', keepHistory: true });
    expect(await t.execute({ op: 'dismiss', agent: 'researcher', keepHistory: false }))
      .toEqual({ ok: true, name: 'researcher', historyKept: false, stoppedJobs: [] });
    expect(calls[1].input).toEqual({ name: 'researcher', keepHistory: false });
  });

  test('missing required args are sharp refusals, classified bad_input — not deps calls, not defects', async () => {
    const { deps, calls } = makeTeam();
    const t = agentsTool({ team: deps });

    for (const [call, missing] of [[{ op: 'hire', role: 'r' }, 'mission'], [{ op: 'assign', agent: 'x' }, 'message'], [{ op: 'message', agent: 'x' }, 'message'], [{ op: 'dismiss' }, 'agent']] as const) {
      await expect(t.execute(call)).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining(`"${missing}" is required`) });
    }

    expect(calls).toEqual([]);
  });

  test('a peers-only actor is not offered a subordinate hire, and asking for one is refused, not indicted', async () => {
    const t = agentsTool({ peers: makePeers().deps });
    await expect(t.execute({ op: 'hire', role: 'r', mission: 'm' })).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('unknown op "hire"') });
  });

  test('a name on neither roster is a caller mistake, not an unknown transport state', async () => {
    const t = agentsTool({ team: makeTeam().deps });
    await expect(t.execute({ op: 'assign', agent: 'ghost', message: 'x' })).rejects.toMatchObject({ code: 'bad_input', message: 'unknown agent "ghost": check the roster with op:"list"' });
    await expect(t.execute({ op: 'message', agent: 'ghost', message: 'x' })).rejects.toMatchObject({ code: 'bad_input', message: 'unknown agent "ghost": check the roster with op:"list"' });
  });

  test('deps exceptions surface as tool error objects (never throw into the turn)', async () => {
    const { deps } = makeTeam({
      assign: async () => { throw new Error('subordinate "researcher" is dismissed'); },
    });

    const t = agentsTool({ team: deps });
    await expect(t.execute({ op: 'assign', agent: 'researcher', message: 'x' })).rejects.toThrow('dismissed');
  });
});

describe('agents tool — peer workspace actions', () => {
  test('a hire naming a non-roster agent routes to the peer transport and returns the reply', async () => {
    const team = makeTeam();
    const peers = makePeers();
    const t = agentsTool({ team: team.deps, peers: peers.deps });
    const result = await t.execute({ op: 'assign', agent: 'scout', message: 'What changed?', topic: 'research' });
    expect(result).toEqual({ status: 'replied', from: 'scout', reply: 'answer' });
    expect(peers.calls[0].input).toMatchObject({ agent: 'scout', topic: 'research', message: 'What changed?', mode: 'build' });
    expect(team.calls).toEqual([]);
  });

  test('a subordinate name wins an addressing collision with a peer', async () => {
    const team = makeTeam();
    const peers = makePeers({ listPeers: async () => [{ name: 'researcher' }] });
    const t = agentsTool({ team: team.deps, peers: peers.deps });
    await t.execute({ op: 'assign', agent: 'researcher', message: 'x' });
    expect(team.calls[0]?.action).toBe('assign');
    expect(peers.calls).toEqual([]);
  });

  test('a peer hire has no elapsed deadline and refuses the retired field', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await t.execute({ op: 'assign', agent: 'scout', message: 'x' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({
      agent: 'scout', topic: 'message', message: 'x', mode: 'build',
    });
    expect('timeoutMs' in (calls[0]?.input ?? {})).toBe(false);

    await expect(t.execute({ op: 'assign', agent: 'scout', message: 'x', timeout_seconds: 1 })).rejects.toThrow('unknown field "timeout_seconds"');
    expect(calls).toHaveLength(1);
  });

  test('msg by agent is fire-and-forget; msg by event_id answers that event', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    expect(await t.execute({ op: 'message', agent: 'scout', message: 'FYI' }))
      .toEqual({ status: 'delivered', message_id: 'ox1' });
    expect(await t.execute({ op: 'reply', eventId: 'pe1', message: 'here you go' })).toEqual({ ok: true });
    expect(calls[1].input).toEqual({ eventId: 'pe1', message: 'here you go' });
  });

  test('a reply names its event and a message names its agent, never both', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await expect(t.execute({ op: 'reply', agent: 'scout', eventId: 'pe1', message: 'x' }))
      .rejects.toMatchObject({ code: 'bad_input', message: 'agents.reply: unknown field "agent". It takes: eventId, message.' });
    await expect(t.execute({ op: 'message', message: 'x' }))
      .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('"agent" is required') });
    expect(calls).toEqual([]);
  });

  test('hire scope=workspace forwards mission as purpose + message (the old spawn_workspace, verbatim transport)', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });

    const result = await t.execute({
      op: 'hireWorkspace', mission: 'summarize research papers', message: 'Summarize X',
    });

    expect(result).toMatchObject({ agent: 'specialist', created: true, status: 'replied' });
    expect(calls[0].input).toEqual({
      purpose: 'summarize research papers', message: 'Summarize X', mode: 'build',
    });
  });

  test('list merges subordinates and peers into one roster', async () => {
    const t = agentsTool({ team: makeTeam().deps, peers: makePeers().deps });
    expect(await t.execute({ op: 'list' })).toEqual({
      subordinates: [rosterEntry],
      peers: [{ name: 'scout', displayName: 'Scout' }],
    });
  });

  test('missing required args are sharp errors, not deps calls', async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });

    for (const [call, missing] of [[{ op: 'assign', agent: 'scout' }, 'message'], [{ op: 'message', agent: 'scout' }, 'message'], [{ op: 'hireWorkspace', message: 'x' }, 'mission']] as const) {
      await expect(t.execute(call)).rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining(`"${missing}" is required`) });
    }

    expect(calls).toEqual([]);
  });

  test(`the reserved "${PEER_REPLY_TOPIC}" topic is rejected`, async () => {
    const { deps, calls } = makePeers();
    const t = agentsTool({ peers: deps });
    await expect(t.execute({ op: 'message', agent: 'scout', message: 'x', topic: PEER_REPLY_TOPIC }))
      .rejects.toThrow('reserved');
    expect(calls).toEqual([]);
  });
});

// Stored rows are re-driven, not answered, so the filter translates rather than refuses and
// names what it dropped. It is also the detach gate (orchestrator/background-tools.ts).

describe('agents tool — resuming a stored delegation row', () => {
  /** `diagnostics` writes JSON lines to console.error with no injection seam. */
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
      op: 'swarm', preset: 'optimise', task: 'search', depth: 3, budgetUsd: 5,
    })).toEqual({ op: 'swarm', preset: 'optimise', task: 'search', depth: 3, budgetUsd: 5 });
  });

  test('a row carrying a field a search does not take still resumes, and the drop is logged', () => {
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      op: 'swarm', preset: 'ideate', task: 'search', budget_usd: 5,
    }));

    // `budget_usd` never applied originally, so dropping it reproduces that run.
    expect(resumed).toEqual({ op: 'swarm', preset: 'ideate', task: 'search' });
    const dropped = lines.filter((line) => line.includes('agents.resume.fields_dropped'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('budget_usd');
  });

  test('a stored field the target action does not read is narrowed away, so the re-drive is not refused', async () => {
    // `topic` is declared, so a lenient parse keeps it and the strict tool parse would refuse the row;
    // the filter builds the call from the target action's fields only.
    const { result: resumed, lines } = captureEvents(() => resumableAgentsInput('agents', {
      op: 'swarm', preset: 'ideate', task: 'search', topic: 'stale',
    }));

    expect(resumed).toEqual({ op: 'swarm', preset: 'ideate', task: 'search' });
    expect(lines.filter((line) => line.includes('agents.resume.fields_dropped'))).toHaveLength(1);

    if (!resumed) throw new Error('expected a resumable agents input');
    const replayed = v.parse(v.record(v.string(), v.unknown()), await agentsTool({ swarm: swarmDeps() }).execute(resumed));
    expect(replayed['reason']).toBeUndefined();
    expect(replayed['error']).toBeUndefined();
    expect(replayed['report']).toBeDefined();
  });

  test('a stored row for a converse action is not resumable, and neither is another tool', () => {
    // `fork` is an action the tool no longer has: refused like any action it never had.
    expect(resumableAgentsInput('agents', { action: 'fork', task: 'search', forks: twoForks })).toBeNull();
    expect(resumableAgentsInput('agents', { action: 'probe', task: 'search' })).toBeNull();
    expect(resumableAgentsInput('agents', { op: 'hire', role: 'r', mission: 'm' })).toBeNull();
    expect(resumableAgentsInput('agents', { action: 'ask', agent: 'a', message: 'm' })).toBeNull();
    expect(resumableAgentsInput('shell', { command: 'ls' })).toBeNull();
  });
});

