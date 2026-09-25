/** Unit tests for the canonical tool surface. `skills` is not a BuiltinToolDeps field. */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { tool, jsonSchema } from 'ai';
import * as v from 'valibot';
import { createTestRuntime, storesFor } from './helpers';
import {
  narrowToolSurface, codemodeCapabilitiesFor, TOOL_REACH,
  buildActorTools,
  buildBuiltinTools,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  createMemoryCodemodeProvider,
  createReportCodemodeProvider,
  withApprovalGatedShell,
  projectJsonValue,
  type CodemodeProvider,
  type CraftedToolExecute,
  type CodemodeBuilder,
  type JsonValue,
  type MemoryToolInput,
  type ReportToolDeps,
  type SubordinateReportHandoff,
  type TeamToolDeps,
  type AgentRuntime,
  TurnEscalationLedger,
} from '../src/index';
import { ROOT_DELEGATION_BUDGET } from '../src/subordinates/depth';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';

interface CircularValue {
  self?: CircularValue;
}

// Core has no in-process fallback; tests wire cli-backend's Node executor factory.
const nodeCraftedExecute: CraftedToolExecute = (t) => {
  let compiled: ((arg: JsonValue) => Promise<JsonValue | undefined>) | null = null;

  return async (arg) => {
    if (!compiled) {
      const evaluated = v.parse(v.function(), new Function('return (' + t.code + ')')());
      compiled = async (input) => {
        const result = await evaluated(input);

        return v.safeParse(v.undefined(), result).success
          ? undefined
          : projectJsonValue({ value: result });
      };
    }

    return compiled(arg);
  };
};

const nodeCodemodeBuilder: CodemodeBuilder = (surface) => {
  return tool({
    description: 'test exec_tools',
    inputSchema: jsonSchema<{ code: string }>({
      type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
    }),
    execute: async (a: { code: string }) => {
      try {
        // A double that also bound `codemode` would keep passing after the alias was removed.
        const crafted: Record<string, (arg: JsonValue) => Promise<JsonValue | undefined>> = {};

        for (const [name, entry] of Object.entries(surface.craftedTools())) {
          crafted[name] = entry.execute;
        }

        const fn = new Function('workspace', 'tools', 'return (async () => { ' + a.code + ' })()');
        const rawResult = await fn({}, crafted);

        const result = v.safeParse(v.undefined(), rawResult).success
          ? undefined
          : projectJsonValue({ value: rawResult });

        return { result };
      } catch (error) {
        return { result: undefined, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
};

/** The builtin surface with a working sandbox: an actor's, minus delegation. */
function tools(
  rt: AgentRuntime,
  escalations: TurnEscalationLedger = new TurnEscalationLedger(),
) {
  return buildActorTools({
    rt,
    history: storesFor(rt).history,
    escalations,
    craftedToolExecute: nodeCraftedExecute,
    codemode: nodeCodemodeBuilder,
    effectClaims: { sql: rt.storage.sql, actor: rt.actor, turnId: () => 'turn-1' },
  });
}

const CONDITIONAL_TOOLS = ['agents', 'web', 'report'] as const;

const CONDITIONAL_TOOL_NAMES = new Set<string>(CONDITIONAL_TOOLS);

const BASE_TOOLS = BUILTIN_TOOLS.filter(
  (name) => !CONDITIONAL_TOOL_NAMES.has(name),
);

/** A FactsStore over one in-memory map, exposed so a test can read what the tool wrote. */
function factsOverMap() {
  const store = new Map<string, { key: string; value: JsonValue; confidence: number; source: string; lastObservedAt: number }>();

  const facts = {
    upsert: (key: string, value: JsonValue, opts?: { confidence?: number }) => {
      store.set(key, { key, value, confidence: opts?.confidence ?? 1, source: 'tool', lastObservedAt: 7 });

      return 'created' as const;
    },
    recall: (key: string) => store.get(key) ?? null,
    forget: (key: string) => { store.delete(key); },
    recentTopK: () => [], all: () => [],
  };

  return { store, facts };
}

function codemodeExecute(provider: CodemodeProvider, name: string): (...args: JsonValue[]) => Promise<object | string | number | boolean | null | undefined> {
  const entry = provider.tools[name];

  if (!entry) throw new Error(`Expected ${provider.name}.${name} to be registered`);

  return async (...args) => await entry.execute(...args);
}

describe('Agent tools (canonical surface — skills/agents/web conditional)', () => {
  test('without conditional deps: base tools only', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const names = Object.keys(t);

    for (const canonical of BASE_TOOLS) expect(names).toContain(canonical);

    for (const conditional of CONDITIONAL_TOOLS) expect(names).not.toContain(conditional);
    expect(names.length).toBe(BASE_TOOLS.length);
  });

  test('with all conditional deps: full canonical surface present', () => {
    const { rt } = createTestRuntime();

    const stubFacts = {
      upsert: () => 'created' as const, recall: () => null, forget: () => {},
      recentTopK: () => [], all: () => [],
    };

    const stubWebSearch = {
      search: async (query: string) => ({ query, results: [], source: 'duckduckgo' as const }),
      fetch: async (url: string) => ({ url, retrievedAt: new Date().toISOString(), markdown: '' }),
    };

    const stubHandoff = {
      eventId: 'evt-1', delivery: 'starts_now' as const,
      phase: { busy: false, lastActivityAt: null, workingOn: null },
    };

    const stubTeam: TeamToolDeps = {
      delegation: ROOT_DELEGATION_BUDGET,
      snapshot: () => [],
      list: async () => [],
      create: async () => ({
        name: 's',
        displayName: 'S',
        subordinate: { name: 's', displayName: 'S', role: 'researcher', actorReference: null, birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
      }),
      rename: async () => ({
        ok: true as const,
        name: 's',
        displayName: 'S',
        subordinate: { name: 's', displayName: 'S', role: 'researcher', actorReference: null, birth: null, deleteRequested: false, createdBy: 'user', status: 'idle', currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null },
      }),
      recordTitle: async () => ({ ok: true as const, name: 's', displayName: 'S', applied: true }),
      spawn: async () => ({ name: 's', displayName: 'S' }),
      assign: async () => ({ ok: true as const, name: 's', ...stubHandoff }),
      knows: async () => true,
      status: async () => ({}),
      message: async () => ({ ok: true as const, name: 's', ...stubHandoff }),
      dismiss: async () => ({ ok: true as const, name: 's', historyKept: false }),
    };

    const stubPeers = {
      listPeers: async () => [],
      ask: async () => ({ status: 'replied' as const, from: 'a', reply: 'stub' }),
      send: async () => ({ status: 'queued' as const, message_id: 'm1' }),
      reply: async () => ({ ok: true as const }),
      spawnWorkspace: async () => ({
        agent: 'a', created: true, status: 'replied' as const, from: 'a', reply: 'stub',
      }),
    };

    const stubReport = {
      report: async () => ({ delivered: true }),
    };

    const t = buildActorTools({
      rt,
      history: storesFor(rt).history,
      craftedToolExecute: nodeCraftedExecute,
      codemode: nodeCodemodeBuilder,
      facts: stubFacts,
      webSearch: stubWebSearch,
      agents: { mode: 'build', team: stubTeam, peers: stubPeers },
      report: stubReport,
      // Wired over the same SQL the backends use, not a stand-in that records nothing.
      effectClaims: { sql: rt.storage.sql, actor: rt.actor, turnId: () => 'turn-1' },
    });

    const names = Object.keys(t);

    for (const canonical of BUILTIN_TOOLS) expect(names).toContain(canonical);
    expect(names.length).toBe(BUILTIN_TOOLS.length);
  });

  test('each tool carries description + inputSchema', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);

    for (const [, entry] of Object.entries(t)) {
      expect(entry.description).toMatch(/\S/);
      const schema = v.parse(v.object({ jsonSchema: v.object({ type: v.string() }) }), entry.inputSchema);
      expect(schema.jsonSchema.type).toBe('object');
    }
  });

  test('descriptions name no retired alias or false shell limit', () => {
    // No `codemode.*`: a refusing alias in the description is a name the model keeps reaching for.
    expect(BUILTIN_TOOL_DESCRIPTIONS.eval).not.toContain('codemode.*');
    expect(BUILTIN_TOOL_DESCRIPTIONS.shell).not.toContain('small fixed command set');
    expect(BUILTIN_TOOL_DESCRIPTIONS.shell).not.toContain('running programs there fails');
  });

  test('memory action=save appends to MEMORY.md', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const memoryTool = { execute: toolExecute<{ action: 'save' | 'search'; content?: string; query?: string }, string>(t.memory) };

    const result = await memoryTool.execute({ action: 'save', content: 'Remember: Python prefers snake_case' });
    expect(result).toContain('saved');

    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('snake_case');
  });

  test('memory action=search returns a string', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);

    await rt.memory.write('memory/test.md', 'This is about machine learning');
    await rt.memory.index('memory/test.md');

    const memoryTool = { execute: toolExecute<{ action: 'save' | 'search'; content?: string; query?: string }, string>(t.memory) };
    const result = await memoryTool.execute({ action: 'search', query: 'machine learning' });
    expect(result).toContain('machine learning');
  });

  test('memory keyed-fact actions round-trip through the facts store', async () => {
    const { rt } = createTestRuntime();
    const { facts } = factsOverMap();

    const t = buildBuiltinTools({
      rt, craftedToolExecute: nodeCraftedExecute,
      history: storesFor(rt).history,
      facts,
    });

    const memory = { execute: toolExecute<MemoryToolInput, JsonValue>(t.memory) };

    expect(await memory.execute({ action: 'remember', key: 'user.tz', value: 'UTC', confidence: 0.9 }))
      .toEqual({ ok: true, key: 'user.tz' });
    expect(await memory.execute({ action: 'recall', key: 'user.tz' })).toMatchObject({
      found: true, key: 'user.tz', value: 'UTC', confidence: 0.9,
    });
    expect(await memory.execute({ action: 'forget', key: 'user.tz' }))
      .toEqual({ ok: true, key: 'user.tz', existed: true });
    expect(await memory.execute({ action: 'recall', key: 'user.tz' })).toEqual({ found: false, key: 'user.tz' });

    // The pre-flight that keeps a non-serializable value from crashing the turn.
    const circular: CircularValue = {};
    circular.self = circular;
    await expect(memory.execute({ action: 'remember', key: 'k', value: circular })).rejects.toMatchObject({ code: 'bad_input' });
    await expect(memory.execute({ action: 'recall', key: '' })).rejects.toThrow('key must be a non-empty string');
  });

  test('the full durable-state surface renders the registry description verbatim', () => {
    // The cache prefix advertises BUILTIN_TOOL_DESCRIPTIONS.memory; the tool's own must not drift from it.
    const { rt } = createTestRuntime();

    const t = buildBuiltinTools({
      rt, craftedToolExecute: nodeCraftedExecute,
      history: storesFor(rt).history,
      facts: { upsert: () => 'created' as const, recall: () => null, forget: () => {}, recentTopK: () => [], all: () => [] },
    });

    expect(t.memory.description).toBe(BUILTIN_TOOL_DESCRIPTIONS.memory);
  });

  test('without a facts store the keyed-fact actions are not on the schema', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);

    const schema = v.parse(v.object({
      jsonSchema: v.object({
        properties: v.object({ action: v.object({ enum: v.array(v.string()) }) }),
      }),
    }), t.memory.inputSchema);

    expect(schema.jsonSchema.properties.action.enum).toEqual(['save', 'search', 'conversations']);
    expect(t.memory.description).not.toContain('remember');
  });

  // memory.* / tasks.* / report.* codemode share the native tool's dispatcher.

  test('memory.* dispatches through the SAME store the native `memory` tool reads/writes', async () => {
    const { rt } = createTestRuntime();
    const { history } = storesFor(rt);

    const provider = createMemoryCodemodeProvider(() => ({
      memory: rt.memory, sql: rt.storage.sql, actor: rt.actor,
      transcriptFor: (sessionId) => history.transcript(sessionId),
    }));

    // No facts wired: remember/recall/forget are absent, as in the native tool.
    expect(Object.keys(provider.tools).sort()).toEqual(['conversations', 'save', 'search']);
    const saved = await codemodeExecute(provider, 'save')('Remember: prefer snake_case');
    expect(v.parse(v.string(), saved)).toContain('saved');
    const found = await rt.memory.read('memory/MEMORY.md');
    expect(found).toContain('snake_case');
  });

  test('memory.* exposes remember/recall/forget only when a FactsStore is wired, over the SAME store', async () => {
    const { rt } = createTestRuntime();
    const { history } = storesFor(rt);
    const { store, facts } = factsOverMap();

    const provider = createMemoryCodemodeProvider(() => ({
      memory: rt.memory, sql: rt.storage.sql, actor: rt.actor, facts,
      transcriptFor: (sessionId) => history.transcript(sessionId),
    }));

    expect(Object.keys(provider.tools)).toContain('remember');
    await codemodeExecute(provider, 'remember')('user.tz', 'UTC', 0.9);
    expect(store.get('user.tz')?.value).toBe('UTC');

    const recalled = v.parse(v.object({
      found: v.boolean(), key: v.string(), value: v.unknown(), confidence: v.number(),
      source: v.string(), lastObservedAt: v.number(),
    }), await codemodeExecute(provider, 'recall')('user.tz'));

    expect(recalled).toEqual({ found: true, key: 'user.tz', value: 'UTC', confidence: 0.9, source: 'tool', lastObservedAt: 7 });
    await codemodeExecute(provider, 'forget')('user.tz');
    expect(store.has('user.tz')).toBe(false);
  });

  // tasks.* codemode parity is tested in unit-tasks-tool.test.ts.

  test('report.* dispatches through the SAME ReportToolDeps.report the native `report` tool calls', async () => {
    let captured = {} satisfies { status?: string; content?: string };

    const deps = { report: async (input: { status: 'progress' | 'completed' | 'blocked'; content: string }) => {
      captured = input;

      return { delivered: true };
    } };

    const provider = createReportCodemodeProvider(() => deps);
    const result = await codemodeExecute(provider, 'send')('completed', 'Fix landed; tests added.');
    expect(result).toEqual({ delivered: true });
    expect(captured).toEqual({ status: 'completed', content: 'Fix landed; tests added.' });
  });

  test('report.send carries a third-argument handoff to the same deps, and refuses a field it does not own', async () => {
    const delivered: Array<{ status: string; content: string; handoff?: SubordinateReportHandoff }> = [];

    const deps: ReportToolDeps = { report: async (input) => {
      delivered.push(input);

      return { ok: true };
    } };

    const provider = createReportCodemodeProvider(() => deps);

    await codemodeExecute(provider, 'send')('blocked', 'Cannot proceed.', {
      concerns: ['the migration is irreversible once it starts'],
      open_work: ['the backfill, once someone confirms the window'],
    });
    expect(delivered).toEqual([{
      status: 'blocked',
      content: 'Cannot proceed.',
      handoff: {
        concerns: ['the migration is irreversible once it starts'],
        open_work: ['the backfill, once someone confirms the window'],
      },
    }]);

    // An invented name is refused here rather than silently stripped by the payload schema.
    expect(await codemodeExecute(provider, 'send')('completed', 'Done.', { thoughts: ['nice task'] }))
      .toMatchObject({ error: expect.stringContaining('concerns, deviations, findings, open_work') });
    expect(delivered).toHaveLength(1);
  });

  test('the native `report` declares the handoff fields — except to a destination that reads only the body', () => {
    const { rt } = createTestRuntime();

    const propertiesOf = (report: ReportToolDeps): string[] => Object.keys(v.parse(
      v.object({ jsonSchema: v.object({ properties: v.record(v.string(), v.unknown()) }) }),
      buildBuiltinTools({ rt, report, history: storesFor(rt).history }).report?.inputSchema,
    ).jsonSchema.properties);

    const sink: ReportToolDeps['report'] = async () => ({ ok: true });
    expect(propertiesOf({ report: sink }))
      .toEqual(['status', 'content', 'concerns', 'deviations', 'findings', 'open_work']);
    // A slot the destination drops must not be offered: the model fills it and the parent never sees it.
    expect(propertiesOf({ report: sink, bodyOnly: true })).toEqual(['status', 'content']);
  });

  test('run with no workspace shell REFUSES with a classification, not a bare string', async () => {
    // `unsupported`: this runtime has no shell, and retrying cannot change that.
    const { rt } = createTestRuntime();
    const t = tools({ ...rt, shell: undefined });
    const shellTool = { execute: toolExecute<{ command: string }, string>(t.shell) };
    await expect(shellTool.execute({ command: 'echo hi' })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('no workspace shell') });
  });

  test('run with an unprovisioned runtime returns structured runtime_not_provisioned', async () => {
    // The UI parses this JSON shape (parseProvisionError in WorkspacePage.tsx) to render the install card.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const shellTool = { execute: toolExecute<{ command: string; runtime?: string }, string>(t.shell) };

    for (const runtime of ['sandbox', 'nimbus', 'device'] as const) {
      const pending = shellTool.execute({ command: 'echo hi', runtime });
      await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
      await expect(pending).rejects.toThrow('runtime_not_provisioned');
    }
  });

  test('escalating records the decision and the stated reason; staying in the workspace records nothing', async () => {
    // `shell` must call the ledger at dispatch, or the escalation row is declared and emitted by nothing.
    const { rt } = createTestRuntime();
    const escalations = new TurnEscalationLedger();
    const t = tools(rt, escalations);

    const shellTool = {
      execute: toolExecute<{ command: string; runtime?: string; why?: string }, string>(t.shell),
    };

    // Unprovisioned: the `refused` branch, not a failed command.
    await expect(shellTool.execute({ command: 'echo hi', runtime: 'sandbox', why: 'needs an inbound port' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(escalations.snapshot().escalations).toEqual([
      { runtime: 'sandbox', reason: 'needs an inbound port', outcome: 'refused', count: 1 },
    ]);

    // The workspace shell is the default, not an escalation: the ledger stays unchanged.
    const before = escalations.snapshot().escalations;
    await shellTool.execute({ command: 'echo hi' });
    await shellTool.execute({ command: 'echo hi', runtime: 'workspace' });
    expect(escalations.snapshot().escalations).toEqual(before);
  });

  test('gated run commands return an error the MODEL can act on', async () => {
    // The gate lives at the execution seam (execution/approval.ts), so this needs a real gated shell.
    // The message must not name setShellApprovalMode, an RPC the model cannot reach.
    const { rt } = createTestRuntime();
    const shell = withApprovalGatedShell({ exec: async () => ({ stdout: 'ran', stderr: '', exitCode: 0 }) }, { filesOwner: 'agent' });
    const t = tools({ ...rt, shell });
    const shellTool = { execute: toolExecute<{ command: string }, string>(t.shell) };
    // Force-push is gated even on the agent's own workspace: the harm lands on a remote.
    const pending = shellTool.execute({ command: 'git push --force origin main' });
    await expect(pending).rejects.toThrow('needs owner approval, nobody to ask');
    await expect(pending).rejects.toThrow('git-force-push');
    await expect(pending).rejects.not.toThrow('setShellApprovalMode');
  });

  test('eval exposes the workspace and tools globals', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const evalTool = { execute: toolExecute<{ code: string }, { result: unknown }>(t.eval) };

    const result = await evalTool.execute({
      code: "return typeof workspace + ',' + typeof tools;",
    });

    expect(result.result).toBe('object,object');
  });

  test('crafted tools become bare callables under tools.<name>', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'double', description: 'doubles a number', params: null,
      code: 'async (x) => x * 2', scope: 'local',
    });

    const t = tools(rt);

    const evalTool = {
      execute: toolExecute<{ code: string }, { result: JsonValue | undefined; error?: string }>(t.eval),
    };

    const result = await evalTool.execute({ code: 'return await tools.double(21);' });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  test('low-scoring crafted tools filtered out of the tools namespace', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'weak', description: 'low quality', params: null,
      code: 'async () => "should never run"', scope: 'local',
    });
    void rt.storage.sql`UPDATE crafted_tools SET score = 0.01, last_used_at = ${Date.now()} WHERE name = 'weak'`;

    const t = tools(rt);
    const evalTool = { execute: toolExecute<{ code: string }, { result: unknown }>(t.eval) };
    const result = await evalTool.execute({ code: 'return typeof tools.weak;' });
    expect(result.result).toBe('undefined');
  });

  test('a crafted tool shadowing a builtin or MCP name never reaches tools.*', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'shell', description: 'shadow', params: null,
      code: 'async () => "should never run"', scope: 'local',
    });
    rt.craftStore.create({
      name: 'mcp_github_get', description: 'shadow', params: null,
      code: 'async () => "should never run"', scope: 'local',
    });
    const log = createRecordingLogger();
    const restore = setDiagnosticsSink(log);
    let injected: string[] = [];

    try {
      buildActorTools({
        rt,
        history: storesFor(rt).history,
        craftedToolExecute: nodeCraftedExecute,
        codemode: (surface) => {
          injected = Object.keys(surface.craftedTools());

          return nodeCodemodeBuilder(surface);
        },
        effectClaims: { sql: rt.storage.sql, actor: rt.actor, turnId: () => 'turn-1' },
      });
    } finally {
      restore();
    }

    expect(injected).not.toContain('shell');
    expect(injected).not.toContain('mcp_github_get');
    const skipped = log.emitted.filter((entry) => entry.event === 'craft.tool_skipped');
    expect(skipped.filter((entry) => entry.fields.tool === 'shell')).toHaveLength(1);
    expect(skipped.filter((entry) => entry.fields.tool === 'mcp_github_get')).toHaveLength(1);
    expect(skipped.every((entry) => entry.code === 'bad_input')).toBe(true);
  });

  // Same-turn `tools.<name>` for a new tool is unsupported; tools created this turn appear next turn.
});

/** Role narrowing applies to the merged set, so a role that keeps `eval` cannot reach
 *  denied capabilities through its codemode providers. */
describe('a role narrows the sandbox as well as the tool list', () => {
  /** A restricted role: keeps sandbox and workspace, loses delegation, memory and tasks. */
  const RESTRICTED = ['eval', 'shell', 'file'];

  test('an excluded capability loses its namespace, not just its tool', () => {
    const narrowing = narrowToolSurface(RESTRICTED);

    // Written out, not derived from TOOL_REACH, so a silently re-pointed row fails here.
    for (const [capability, namespace] of [
      ['agents', 'agents'], ['memory', 'memory'], ['tasks', 'tasks'],
    ] as const) {
      expect(TOOL_REACH[capability].codemode).toBe(namespace);
      expect(narrowing.allowsTool(capability)).toBe(false);
      expect(narrowing.allowsNamespace(namespace)).toBe(false);
    }

    expect(narrowing.narrowProviders([
      { name: 'agents' }, { name: 'memory' }, { name: 'tasks' }, { name: 'workspace' },
    ])).toEqual([{ name: 'workspace' }]);
  });

  test('a namespace two capabilities reach survives while EITHER does', () => {
    // `shell` and `file` both reach `workspace`: losing one keeps the filesystem, losing both drops it.
    expect(narrowToolSurface(['eval', 'shell']).allowsNamespace('workspace')).toBe(true);
    expect(narrowToolSurface(['eval', 'file']).allowsNamespace('workspace')).toBe(true);
    expect(narrowToolSurface(['eval']).allowsNamespace('workspace')).toBe(false);
  });

  test('an absent list allows everything — absent inherits, as it does in the resolver', () => {
    const open = narrowToolSurface(undefined);
    expect(open.allowsTool('agents')).toBe(true);
    expect(open.allowsNamespace('agents')).toBe(true);
    expect(open.allowsNamespace('anything-a-backend-wired')).toBe(true);
    const providers = [{ name: 'agents' }, { name: 'pc' }];
    expect(open.narrowProviders(providers)).toEqual(providers);
  });

  test('an EXTERNAL namespace follows eval, because no role list can name it', () => {
    // Executor planes and backend-wired providers have no reach row; denying them would take the
    // machine from every narrowed role.
    expect(narrowToolSurface(RESTRICTED).allowsNamespace('pc')).toBe(true);
    expect(narrowToolSurface(['shell', 'file']).allowsNamespace('pc')).toBe(false);
  });

  test('the codemode-only capabilities a role may name are the ones actually wired', () => {
    // A role's list is intersected with the surface the backend declares.
    expect(codemodeCapabilitiesFor([{ name: 'db' }, { name: 'agent' }])).toEqual(['agent', 'db']);
    expect(codemodeCapabilitiesFor([{ name: 'agents' }, { name: 'workspace' }])).toEqual(['slate']);
    expect(codemodeCapabilitiesFor([])).toEqual([]);
    expect(codemodeCapabilitiesFor([{ name: 'agent' }, { name: 'web' }])).toEqual(['agent']);
  });

  test('the codemode-only set is derived from the reach table, not restated', () => {
    const nonNative = Object.entries(TOOL_REACH).filter(([, reach]) => !reach.native);

    const everyNamespace = [...new Set(
      nonNative.flatMap(([, reach]) => reach.codemode === null ? [] : [reach.codemode]),
    )].map((name) => ({ name }));

    expect([...codemodeCapabilitiesFor(everyNamespace)].sort())
      .toEqual(nonNative.map(([name]) => name).sort());
  });

  test('a named codemode-only capability keeps its namespace', () => {
    expect(narrowToolSurface(['eval', 'db']).allowsNamespace('db')).toBe(true);
    expect(narrowToolSurface(['eval']).allowsNamespace('db')).toBe(false);
  });

  const provider = (name: string, member: string, answer: string): CodemodeProvider => ({
    name,
    types: '',
    tools: { [member]: { description: `${name}.${member}`, execute: async () => answer } },
  });

  /** Binds only the providers handed over, so a filtered namespace is an unbound name, not an empty object. */
  function sandboxOver(providers: readonly CodemodeProvider[]): (code: string) => Promise<string> {
    const names = providers.map((p) => p.name);

    const values = providers.map((p) => Object.fromEntries(
      Object.entries(p.tools).map(([member, entry]) => [member, entry.execute]),
    ));

    return async (code) => {
      const fn = new Function(...names, `return (async () => { ${code} })()`);

      return v.parse(v.string(), await fn(...values));
    };
  }

  test('a namespace the role lost is not reachable from inside the sandbox', async () => {
    // `typeof` rather than a call: an unbound name throws ReferenceError; a bound-but-empty namespace would not.
    const providers = [
      provider('agents', 'swarm', 'delegated'),
      provider('memory', 'save', 'remembered'),
      provider('tasks', 'add', 'listed'),
      provider('workspace', 'readFile', 'bytes'),
    ];

    const narrowed = narrowToolSurface(RESTRICTED).narrowProviders(providers);
    const run = sandboxOver(narrowed);

    expect(await run('return typeof agents;')).toBe('undefined');
    expect(await run('return typeof memory;')).toBe('undefined');
    expect(await run('return typeof tasks;')).toBe('undefined');
    expect(await run('return await workspace.readFile();')).toBe('bytes');
  });

  test('an unnarrowed actor reaches every namespace it was given', async () => {
    const providers = [provider('agents', 'swarm', 'delegated')];
    const run = sandboxOver(narrowToolSurface(undefined).narrowProviders(providers));
    expect(await run('return await agents.swarm();')).toBe('delegated');
  });
});
