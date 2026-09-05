/**
 * Unit tests for the canonical tool surface.
 *
 * The agent's tool surface is deliberately SMALL (fewer tools → better LLM
 * selection). Always-on (no extra deps): execute_tools, run, file, memory —
 * the ONE durable-state tool, whose keyed-fact actions are themselves gated
 * on `facts` — and tasks.
 * Conditional (needs a specific dep in BuiltinToolDeps):
 *   - agents           ← agents (fork substrate and/or team + peers deps;
 *                        the ONE delegation tool, actions gated per group)
 *   - web              ← webSearch (WebSearchProvider; search/fetch actions)
 *   - report           ← report (subordinate → parent progress spine)
 *
 * `skills` and `release` are NOT part of BuiltinToolDeps at all — skills are
 * ordinary VFS files reachable via workspace.readFile/writeFile/readdir, and
 * release is reached ONLY through the release.* codemode namespace
 * (createReleaseCodemodeProvider, tested below against runReleaseAction
 * directly rather than through buildBuiltinTools).
 *
 * BUILTIN_TOOLS lists every canonical name so crafted-tool filtering
 * (BUILT_IN_TOOL_NAMES) excludes them all from craft suggestions, regardless
 * of whether the runtime happens to wire the conditional dep.
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { tool, jsonSchema } from 'ai';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import {
  narrowToolSurface, codemodeCapabilitiesFor, TOOL_REACH,
  buildActorTools,
  buildBuiltinTools,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  createReleaseCodemodeProvider,
  runReleaseAction,
  createMemoryCodemodeProvider,
  createReportCodemodeProvider,
  withApprovalGatedShell,
  projectJsonValue,
  type CodemodeProvider,
  type CraftedToolExecute,
  type ExecuteToolsBuilder,
  type JsonValue,
  type MemoryToolInput,
  type ReleaseApproval,
  type ReleaseCheck,
  type ReleaseDeployment,
  type ReleaseSource,
  type ReleaseToolDeps,
  type TeamToolDeps,
  type AgentRuntime,
  TurnEscalationLedger,
} from '../src/index';
import { ROOT_DELEGATION_BUDGET } from '../src/subordinates/depth';
import { createRecordingLogger, setDiagnosticsSink } from '../src/obs/index';

interface RecordedReleaseCheck {
  changeId: string;
  input: Parameters<ReleaseToolDeps['recordCheck']>[1];
}

interface CircularValue {
  self?: CircularValue;
}

// v2.1(E): core has no in-process fallback. Tests wire the same Node
// executor factory that cli-backend ships in production.
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

const nodeExecBuilder: ExecuteToolsBuilder = (surface) => {
  return tool({
    description: 'test exec_tools',
    inputSchema: jsonSchema<{ code: string }>({
      type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
    }),
    execute: async (a: { code: string }) => {
      try {
        // Resolved per execute, exactly as the cli-backend builder does, and
        // bound under the ONE namespace core declares. A double that also bound
        // `codemode` would keep passing after the alias was removed.
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

/** The builtin surface with a working sandbox: an actor's, minus delegation.
 *  The claim table is created by `initWorkspaceSchema`, which this runtime
 *  runs, so the effect-claim wrap is the one both backends give it. */
function tools(
  rt: AgentRuntime,
  escalations: TurnEscalationLedger = new TurnEscalationLedger(),
) {
  return buildActorTools({
    rt,
    escalations,
    craftedToolExecute: nodeCraftedExecute,
    executeTools: nodeExecBuilder,
    effectClaims: { sql: rt.storage.sql, turnId: () => 'turn-1' },
  });
}

// agents, web and report are conditional on their deps. Base = everything
// else. Full surface = all canonical tools.
const CONDITIONAL_TOOLS = ['agents', 'web', 'report'] as const;
const CONDITIONAL_TOOL_NAMES = new Set<string>(CONDITIONAL_TOOLS);
const BASE_TOOLS = BUILTIN_TOOLS.filter(
  (name) => !CONDITIONAL_TOOL_NAMES.has(name),
);

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
        subordinate: {
          name: 's', displayName: 'S', role: 'researcher', createdBy: 'user', status: 'idle',
          currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null,
        },
      }),
      rename: async () => ({
        ok: true as const,
        name: 's',
        displayName: 'S',
        subordinate: {
          name: 's', displayName: 'S', role: 'researcher', createdBy: 'user', status: 'idle',
          currentTask: null, createdAt: 1, dismissedAt: null, lifetime: 'durable', taskEventId: null,
        },
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
      craftedToolExecute: nodeCraftedExecute,
      executeTools: nodeExecBuilder,
      facts: stubFacts,
      webSearch: stubWebSearch,
      agents: { mode: 'build', team: stubTeam, peers: stubPeers },
      report: stubReport,
      // The claim table is created by `initWorkspaceSchema`, which this runtime
      // already ran, so the once-only boundary is wired over the SAME SQL the
      // backends give it rather than a stand-in that records nothing.
      effectClaims: { sql: rt.storage.sql, turnId: () => 'turn-1' },
    });
    const names = Object.keys(t);
    for (const canonical of BUILTIN_TOOLS) expect(names).toContain(canonical);
    expect(names.length).toBe(BUILTIN_TOOLS.length);
  });

  test('each tool carries description + inputSchema', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    for (const [, entry] of Object.entries(t)) {
      expect(entry.description).toBeTruthy();
      expect(entry.inputSchema).toBeTruthy();
    }
  });

  test('descriptions document the one tools.<name> namespace and the state store', () => {
    // ONE namespace for every tool the program can call, native and crafted;
    // `codemode.*` is gone (it used to be a refusing alias the model kept
    // reaching for). `state.*` is what outlives a program.
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).not.toContain('codemode.*');
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('`tools.<name>(input)`');
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('`state.*`');
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('canonical durable workspace');
    expect(BUILTIN_TOOL_DESCRIPTIONS.run).toContain('shell over the canonical durable workspace');
    expect(BUILTIN_TOOL_DESCRIPTIONS.run).not.toContain('small fixed command set');
    expect(BUILTIN_TOOL_DESCRIPTIONS.run).not.toContain('running programs there fails');
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
    const t = buildBuiltinTools({
      rt, craftedToolExecute: nodeCraftedExecute,
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
    expect(await memory.execute({ action: 'remember', key: 'k', value: circular })).toHaveProperty('error');
    expect(await memory.execute({ action: 'recall', key: '' })).toEqual({ error: 'key must be a non-empty string' });
  });

  test('the full durable-state surface renders the registry description verbatim', () => {
    // The byte-stable cache prefix advertises BUILTIN_TOOL_DESCRIPTIONS.memory;
    // the tool composes its own from the same spec, so the two must not drift.
    const { rt } = createTestRuntime();
    const t = buildBuiltinTools({
      rt, craftedToolExecute: nodeCraftedExecute,
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
    // ...and the docstring does not advertise what the runtime cannot do.
    expect(t.memory.description).not.toContain('remember');
  });

  // ── release.* codemode (not a native tool — see file header) ─────────────
  // The release lane has two halves and no actor has both: an engine EARNS
  // apply/run_checks/preview/deploy/rollback from real command output and
  // refuses the record_* twins as assertions; without one the record_* actions
  // are the only way the ledger learns what the agent ran itself. The
  // codemode member set gates on the same dep the runtime does, so neither
  // actor reads the other's.
  const releaseChange = {
    id: 'chg-1', agentName: 'jarvis', bindingId: 'src-1', status: 'draft' as const,
    userPrompt: 'ship it', plan: null, summary: null, patch: null, previewUrl: null,
    createdAt: 1, updatedAt: 1,
  };
  const releaseSource: ReleaseSource = {
    id: 'src-1', kind: 'local', label: 'workspace', repoUrl: null,
    defaultBranch: null, localDeviceId: null, localRoot: '/workspace',
    deployTarget: null, createdAt: 1, updatedAt: 1,
  };
  const releaseCheck: ReleaseCheck = {
    id: 'chk-1', changeId: 'chg-1', name: 'tests', status: 'passed',
    stdout: null, stderr: null, durationMs: null, createdAt: 1, updatedAt: 1,
  };
  const releaseApproval: ReleaseApproval = {
    id: 'approval-1', changeId: 'chg-1', approvalType: 'apply', decision: 'pending',
    approvedBy: null, note: null, argumentDigest: 'digest', createdAt: 1, decidedAt: null,
  };
  const releaseDeployment: ReleaseDeployment = {
    id: 'deployment-1', changeId: 'chg-1', environment: 'local',
    workerVersionId: null, deploymentId: null, rollbackTarget: null, deployedAt: 1,
  };
  const releaseLedgerDeps: ReleaseToolDeps = {
    board: async () => ({ bindings: [], changes: [], checks: [], approvals: [], deployments: [] }),
    bindSource: async () => releaseSource, create: async () => releaseChange,
    update: async () => releaseChange, transition: async () => releaseChange,
    recordCheck: async () => releaseCheck,
    requestApproval: async () => releaseApproval,
    recordDeployment: async () => releaseDeployment,
  };

  test('with an execution engine, release.* offers only what execution earns', () => {
    const deps: ReleaseToolDeps = {
      ...releaseLedgerDeps,
      engine: {
        apply: async () => ({ ok: true, workdir: '/workspace', commit: 'abc1234', status: 'patching' }),
        runChecks: async () => ({ ok: true, allPassed: true, results: [], status: 'preview_ready' }),
        preview: async () => ({ ok: true, url: 'https://preview.example.com' }),
        deploy: async () => ({
          ok: true, environment: 'local', workerVersionId: null, deploymentId: null,
          rollbackTarget: null, status: 'deployed',
        }),
        rollback: async () => ({ ok: true, restored: 'abc1234', verified: true, status: 'rolled_back' }),
      },
    };
    const provider = createReleaseCodemodeProvider(() => deps);
    expect(Object.keys(provider.tools).sort()).toEqual([
      'apply', 'bindSource', 'board', 'create', 'deploy', 'preview',
      'requestApproval', 'rollback', 'runChecks', 'transition', 'update',
    ]);
    // The record_* twins belong to the no-engine half only.
    expect(provider.tools.recordCheck).toBeUndefined();
    expect(provider.tools.recordDeployment).toBeUndefined();
    expect(provider.types).toContain('apply(changeId: string)');
    expect(provider.types).not.toContain('recordCheck(');
  });

  test('without an execution engine, release.* is the ledger, and the record_* twins are how it learns what ran', () => {
    const provider = createReleaseCodemodeProvider(() => releaseLedgerDeps);
    expect(Object.keys(provider.tools).sort()).toEqual([
      'bindSource', 'board', 'create', 'recordCheck', 'recordDeployment',
      'requestApproval', 'transition', 'update',
    ]);
    expect(provider.tools.apply).toBeUndefined();
    expect(provider.tools.runChecks).toBeUndefined();
    expect(provider.types).toContain('recordCheck(');
    expect(provider.types).not.toContain('apply(');
  });

  test('release.* members dispatch through the SAME runReleaseAction the provider is built on', async () => {
    const recorded: RecordedReleaseCheck[] = [];
    const deps: ReleaseToolDeps = {
      ...releaseLedgerDeps,
      recordCheck: async (changeId, input) => {
        recorded.push({ changeId, input });
        return releaseCheck;
      },
    };
    const provider = createReleaseCodemodeProvider(() => deps);
    const result = await codemodeExecute(provider, 'recordCheck')(
      'chg-1',
      { name: 'tests', status: 'passed' },
    );
    expect(result).toEqual(releaseCheck);
    expect(recorded).toEqual([{ changeId: 'chg-1', input: { name: 'tests', status: 'passed' } }]);
    // The dispatcher's own validation still applies — a missing changeId
    // refuses cleanly rather than throwing.
    const refused = await runReleaseAction(deps, { action: 'apply' });
    expect(refused).toMatchObject({ error: expect.stringContaining('execution engine') });
  });

  test('with an engine, record_check is refused as an assertion — run_checks earns it', async () => {
    let called = 0;
    const deps: ReleaseToolDeps = {
      ...releaseLedgerDeps,
      recordCheck: async () => {
        called += 1;
        return releaseCheck;
      },
      engine: {
        apply: async () => ({ ok: true, workdir: '/workspace', commit: 'abc1234', status: 'patching' }),
        runChecks: async () => ({ ok: true, allPassed: true, results: [], status: 'preview_ready' }),
        preview: async () => ({ ok: true, url: 'https://preview.example.com' }),
        deploy: async () => ({
          ok: true, environment: 'local', workerVersionId: null, deploymentId: null,
          rollbackTarget: null, status: 'deployed',
        }),
        rollback: async () => ({ ok: true, restored: 'abc1234', verified: true, status: 'rolled_back' }),
      },
    };
    const result = await runReleaseAction(deps, {
      action: 'record_check', changeId: 'chg-1', check: { name: 'tests', status: 'passed' },
    });
    expect(result).toMatchObject({ error: expect.stringContaining('action=run_checks') });
    expect(called).toBe(0);
  });

  // ── memory.* / tasks.* / report.* codemode (Part 2 — every remaining
  // builtin reachable from execute_tools, sharing its dispatcher with the
  // native tool: one implementation, two callers) ──────────────────────────

  test('memory.* dispatches through the SAME store the native `memory` tool reads/writes', async () => {
    const { rt } = createTestRuntime();
    const provider = createMemoryCodemodeProvider(() => ({ memory: rt.memory, sql: rt.storage.sql }));
    // No facts wired: remember/recall/forget are absent, matching the native
    // tool's own action-enum gating.
    expect(Object.keys(provider.tools).sort()).toEqual(['conversations', 'save', 'search']);
    const saved = await codemodeExecute(provider, 'save')('Remember: prefer snake_case');
    expect(String(saved)).toContain('saved');
    const found = await rt.memory.read('memory/MEMORY.md');
    expect(found).toContain('snake_case');
  });

  test('memory.* exposes remember/recall/forget only when a FactsStore is wired, over the SAME store', async () => {
    const { rt } = createTestRuntime();
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
    const provider = createMemoryCodemodeProvider(() => ({ memory: rt.memory, sql: rt.storage.sql, facts }));
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

  // tasks.* codemode parity is tested in unit-tasks-tool.test.ts, next to the
  // native tool's own tests (same table-init fixture).

  test('report.* dispatches through the SAME ReportToolDeps.report the native `report` tool calls', async () => {
    let captured = {} satisfies { status?: string; content?: string };
    const deps = { report: async (input: { status: 'progress' | 'completed' | 'blocked'; content: string }) => { captured = input; return { delivered: true }; } };
    const provider = createReportCodemodeProvider(() => deps);
    const result = await codemodeExecute(provider, 'send')('completed', 'Fix landed; tests added.');
    expect(result).toEqual({ delivered: true });
    expect(captured).toEqual({ status: 'completed', content: 'Fix landed; tests added.' });
  });

  test('run with no workspace shell REFUSES with a classification, not a bare string', async () => {
    // It used to answer `'Error: no workspace shell available in this runtime.'`
    // — accurate prose carrying no class, so a reader could not tell this apart
    // from a timeout or an OOM. `unsupported`: this runtime has no shell, and
    // retrying cannot change that.
    const { rt } = createTestRuntime();
    const t = tools({ ...rt, shell: undefined });
    const tool = { execute: toolExecute<{ command: string }, string>(t.run) };
    const result = await tool.execute({ command: 'echo hi' });
    const parsed = v.parse(v.object({ reason: v.string(), error: v.string() }), JSON.parse(result));
    expect(parsed.reason).toBe('unsupported');
    expect(parsed.error).toContain('no workspace shell');
    // The discriminator LEADS, where no clamp can reach it.
    expect(result.indexOf('"reason"')).toBeLessThan(result.indexOf('"error"'));
  });

  test('run with an unprovisioned runtime returns structured runtime_not_provisioned', async () => {
    // The UI parses this exact JSON shape (parseProvisionError in
    // WorkspacePage.tsx) to render the amber install-card. Silent fallback to
    // workspace would defeat the install-card flow, so the contract is:
    // `{error:'runtime_not_provisioned', runtime, message}` — with the
    // classification added AHEAD of it, which the UI's `v.object` ignores.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = { execute: toolExecute<{ command: string; runtime?: string }, string>(t.run) };
    for (const runtime of ['sandbox', 'nimbus', 'laptop'] as const) {
      const result = await tool.execute({ command: 'echo hi', runtime });
      const parsed = v.parse(v.object({
        reason: v.string(), error: v.string(), runtime: v.string(), message: v.string(),
      }), JSON.parse(result));
      expect(parsed.error).toBe('runtime_not_provisioned');
      expect(parsed.runtime).toBe(runtime);
      expect(parsed.message.length).toBeGreaterThan(0);
      // `unavailable`, not `unsupported`: a sandbox provisions on first use and a
      // laptop comes back when its daemon does, so this is a retry.
      expect(parsed.reason).toBe('unavailable');
    }
  });

  test('escalating records the decision and the stated reason; staying in the workspace records nothing', async () => {
    // The wiring, not the ledger: `run` must call the ledger AT the dispatch, or
    // the durable `execution_escalation` row is a feature that is declared and
    // emitted by nothing — the exact defect this codebase keeps finding.
    const { rt } = createTestRuntime();
    const escalations = new TurnEscalationLedger();
    const t = tools(rt, escalations);
    const tool = {
      execute: toolExecute<{ command: string; runtime?: string; why?: string }, string>(t.run),
    };

    // Unprovisioned here, so this is the `refused` branch — which is itself the
    // finding "the runtime was never there", not a failed command.
    await tool.execute({ command: 'echo hi', runtime: 'sandbox', why: 'needs an inbound port' });
    expect(escalations.snapshot().escalations).toEqual([
      { runtime: 'sandbox', reason: 'needs an inbound port', outcome: 'refused', count: 1 },
    ]);

    // The workspace shell is the DEFAULT, not an escalation: running there — and
    // naming it explicitly — must leave the ledger exactly as it was.
    const before = escalations.snapshot().escalations;
    await tool.execute({ command: 'echo hi' });
    await tool.execute({ command: 'echo hi', runtime: 'workspace' });
    expect(escalations.snapshot().escalations).toEqual(before);
  });

  test('gated run commands return an error the MODEL can act on', async () => {
    // Regression: the gate message used to tell the model to call
    // setShellApprovalMode('allow_all') — a backend RPC the model cannot
    // reach. The actionable path is the owner deciding, and the words say so
    // without spending a paragraph on it.
    //
    // The gate itself now lives at the execution seam (`shell`/the
    // ExecutionRouter — see execution/approval.ts), not inside `run`'s own
    // executor, so this needs a real (gated) shell to see the message —
    // createTestRuntime() has none by default.
    const { rt } = createTestRuntime();
    const shell = withApprovalGatedShell({ exec: async () => ({ stdout: 'ran', stderr: '', exitCode: 0 }) });
    const t = tools({ ...rt, shell });
    const tool = { execute: toolExecute<{ command: string }, string>(t.run) };
    // A force-push: gated even on the agent's own workspace, because the harm
    // lands on a remote. `sudo whoami` would run here now — that shell IS the
    // agent's own machine.
    const result = await tool.execute({ command: 'git push --force origin main' });
    expect(result).toContain('needs owner approval, nobody to ask');
    expect(result).toContain('git-force-push');
    expect(result).not.toContain('setShellApprovalMode');
  });

  test('execute_tools exposes the workspace and tools globals', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = { execute: toolExecute<{ code: string }, { result: unknown }>(t.execute_tools) };
    const result = await tool.execute({
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
    const tool = {
      execute: toolExecute<{ code: string }, { result: JsonValue | undefined; error?: string }>(t.execute_tools),
    };
    const result = await tool.execute({ code: 'return await tools.double(21);' });
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
    const tool = { execute: toolExecute<{ code: string }, { result: unknown }>(t.execute_tools) };
    const result = await tool.execute({ code: 'return typeof tools.weak;' });
    expect(result.result).toBe('undefined');
  });

  test('a crafted tool shadowing a builtin or MCP name never reaches tools.*', async () => {
    const { rt } = createTestRuntime();
    rt.craftStore.create({
      name: 'run', description: 'shadow', params: null,
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
        craftedToolExecute: nodeCraftedExecute,
        executeTools: (surface) => {
          injected = Object.keys(surface.craftedTools());
          return nodeExecBuilder(surface);
        },
        effectClaims: { sql: rt.storage.sql, turnId: () => 'turn-1' },
      });
    } finally {
      restore();
    }
    expect(injected).not.toContain('run');
    expect(injected).not.toContain('mcp_github_get');
    const skipped = log.emitted.filter((entry) => entry.event === 'craft.tool_skipped');
    expect(skipped.filter((entry) => entry.fields.tool === 'run')).toHaveLength(1);
    expect(skipped.filter((entry) => entry.fields.tool === 'mcp_github_get')).toHaveLength(1);
    expect(skipped.every((entry) => entry.code === 'bad_input')).toBe(true);
  });

  // v2.1(E): same-turn `tools.<name>` for a NEW tool is not supported. The
  // Proxy live-lookup path used host-side new Function and was removed. Tools
  // created this turn become available next turn (getTools rebuilds).
});

/**
 * Role narrowing over BOTH surfaces from ONE merged set.
 *
 * Narrowing used to be applied to the native ToolSet only, while `execute_tools`
 * built its codemode providers from unfiltered deps. So a role that allowed
 * `execute_tools` and denied `agents` still delegated, hired, and wrote memory
 * through `agents.*` and `memory.*` — the narrowing was decorative for any role
 * that kept the sandbox, which is every role that can do real work.
 */
describe('a role narrows the sandbox as well as the tool list', () => {
  /** The shape a restricted role resolves to: it keeps the sandbox and the
   *  workspace, and loses delegation, memory and the task list. */
  const RESTRICTED = ['execute_tools', 'run', 'file'];

  test('an excluded capability loses its namespace, not just its tool', () => {
    const narrowing = narrowToolSurface(RESTRICTED);
    // The pairs written out rather than re-derived from TOOL_REACH: the test
    // states which namespace each excluded capability owns, so a table that
    // silently re-pointed one would fail here instead of agreeing with itself.
    for (const [capability, namespace] of [
      ['agents', 'agents'], ['memory', 'memory'], ['tasks', 'tasks'],
    ] as const) {
      expect(TOOL_REACH[capability].codemode).toBe(namespace);
      expect(narrowing.allowsTool(capability)).toBe(false);
      expect(narrowing.allowsNamespace(namespace)).toBe(false);
    }
    // And the providers actually go, which is the form a backend consumes:
    // handing this list to `execute_tools` is what binds the namespaces.
    expect(narrowing.narrowProviders([
      { name: 'agents' }, { name: 'memory' }, { name: 'tasks' }, { name: 'workspace' },
    ])).toEqual([{ name: 'workspace' }]);
  });

  test('a namespace two capabilities reach survives while EITHER does', () => {
    // `run` and `file` both reach `workspace`. Losing one must not take the
    // filesystem away, and losing both must.
    expect(narrowToolSurface(['execute_tools', 'run']).allowsNamespace('workspace')).toBe(true);
    expect(narrowToolSurface(['execute_tools', 'file']).allowsNamespace('workspace')).toBe(true);
    expect(narrowToolSurface(['execute_tools']).allowsNamespace('workspace')).toBe(false);
  });

  test('an absent list allows everything — absent inherits, as it does in the resolver', () => {
    const open = narrowToolSurface(undefined);
    expect(open.allowsTool('agents')).toBe(true);
    expect(open.allowsNamespace('agents')).toBe(true);
    expect(open.allowsNamespace('anything-a-backend-wired')).toBe(true);
    const providers = [{ name: 'agents' }, { name: 'pc' }];
    expect(open.narrowProviders(providers)).toEqual(providers);
  });

  test('an EXTERNAL namespace follows execute_tools, because no role list can name it', () => {
    // Executor planes and backend-wired providers have no reach row, so there is
    // no name an owner could write to keep them. Denying them per-namespace
    // would silently take the machine away from every narrowed role — a worse
    // failure than the one being fixed, and a much quieter one.
    expect(narrowToolSurface(RESTRICTED).allowsNamespace('pc')).toBe(true);
    expect(narrowToolSurface(['run', 'file']).allowsNamespace('pc')).toBe(false);
  });

  test('the codemode-only capabilities a role may name are the ones actually wired', () => {
    // A role's list is intersected with the surface a backend declares, so a
    // capability absent from that surface can never be named — and one present
    // but unwired would let a role allow a lane that cannot run.
    expect(codemodeCapabilitiesFor([{ name: 'release' }, { name: 'agent' }])).toEqual(['release', 'agent']);
    expect(codemodeCapabilitiesFor([{ name: 'agents' }, { name: 'workspace' }])).toEqual([]);
    expect(codemodeCapabilitiesFor([])).toEqual([]);
    // Plan mode filters `release` out of its provider list, so a Plan turn's
    // role list cannot name a lane that is physically absent — for free.
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
    expect(narrowToolSurface(['execute_tools', 'release']).allowsNamespace('release')).toBe(true);
    expect(narrowToolSurface(['execute_tools']).allowsNamespace('release')).toBe(false);
  });

  /** A provider namespace as a backend hands it to the sandbox: a name and the
   *  members bound under it. */
  const provider = (name: string, member: string, answer: string): CodemodeProvider => ({
    name,
    types: '',
    tools: { [member]: { description: `${name}.${member}`, execute: async () => answer } },
  });

  /** Bind exactly the providers handed over, the way a codemode loader does:
   *  one parameter per namespace. Nothing else is in scope, so a namespace that
   *  was filtered out is an unbound name rather than an empty object — which is
   *  the difference between "cannot be called" and "answers nothing". */
  function sandboxOver(providers: readonly CodemodeProvider[]): (code: string) => Promise<string> {
    const names = providers.map((p) => p.name);
    const values = providers.map((p) => Object.fromEntries(
      Object.entries(p.tools).map(([member, entry]) => [member, entry.execute]),
    ));
    // Parsed on the way out rather than asserted: every program below answers a
    // string, and a program that stopped doing so should fail here by name
    // instead of flowing on as an unchecked value.
    return async (code) => {
      const fn = new Function(...names, `return (async () => { ${code} })()`);
      return v.parse(v.string(), await fn(...values));
    };
  }

  test('a namespace the role lost is not reachable from inside the sandbox', async () => {
    // The end of the escape route: a role that keeps `execute_tools` and loses
    // `agents` used to delegate and hire through `agents.*` anyway, because the
    // providers were built from unfiltered deps. `typeof` rather than a call,
    // because an unbound name throws a ReferenceError while a bound-but-empty
    // namespace would still be there to reach for.
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
    // And what the role KEPT still works, which is the half a blunt fix breaks.
    expect(await run('return await workspace.readFile();')).toBe('bytes');
  });

  test('an unnarrowed actor reaches every namespace it was given', async () => {
    const providers = [provider('agents', 'swarm', 'delegated')];
    const run = sandboxOver(narrowToolSurface(undefined).narrowProviders(providers));
    expect(await run('return await agents.swarm();')).toBe('delegated');
  });
});
