/**
 * Unit tests for the canonical tool surface.
 *
 * The agent's tool surface is deliberately SMALL (fewer tools → better LLM
 * selection). Always-on (no extra deps): execute_tools, run, memory — the ONE
 * durable-state tool, whose keyed-fact actions are themselves gated on `facts`.
 * Conditional (needs a specific dep in BuiltinToolDeps):
 *   - skills           ← skills (SkillsToolDeps — vfs + invoke tracker)
 *   - agents           ← agents (fork substrate and/or team + peers deps;
 *                        the ONE delegation tool, actions gated per group)
 *   - web              ← webSearch (WebSearchProvider; search/fetch actions)
 *   - release   ← releases (source bindings + approvals store)
 *
 * BUILTIN_TOOLS lists every canonical name so crafted-tool filtering
 * (BUILT_IN_TOOL_NAMES) excludes them all from craft suggestions, regardless
 * of whether the runtime happens to wire the conditional dep.
 */

import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@proteus/test-utils';
import { tool, jsonSchema } from 'ai';
import { createTestRuntime } from './helpers.js';
import {
  buildBuiltinTools,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  type CraftedToolExecute,
} from '../src/index.js';

// v2.1(E): core has no in-process fallback. Tests wire the same Node
// executor factory that cli-backend ships in production.
const nodeCraftedExecute: CraftedToolExecute = (t) => {
  let compiled: ((arg: unknown) => Promise<unknown>) | null = null;
  return async (arg) => {
    if (!compiled) {
      const fn = new Function('return (' + t.code + ')')();
      if (typeof fn !== 'function') throw new Error(`${t.name} not a function`);
      compiled = fn as (arg: unknown) => Promise<unknown>;
    }
    return compiled(arg);
  };
};

const nodeExecFactory = (opts: {
  craftedTools: () => Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
}) => {
  return tool({
    description: 'test exec_tools',
    inputSchema: jsonSchema<{ code: string }>({
      type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
    }),
    execute: async (a: { code: string }) => {
      try {
        // Resolved per execute, exactly as the cli-backend factory does.
        const codemode: Record<string, (arg: unknown) => Promise<unknown>> = {};
        for (const [n, e] of Object.entries(opts.craftedTools())) {
          codemode[n] = e.execute as (arg: unknown) => Promise<unknown>;
        }
        const fn = new Function('workspace', 'codemode', 'tools', 'return (async () => { ' + a.code + ' })()');
        const result = await fn({}, codemode, codemode);
        return { result };
      } catch (e) {
        return { result: undefined, error: (e as Error).message };
      }
    },
  });
};

function tools(rt: ReturnType<typeof createTestRuntime>['rt']) {
  return buildBuiltinTools({
    rt,
    craftedToolExecute: nodeCraftedExecute,
    createExecuteTool: nodeExecFactory as never,
    codemodeLoader: { __test: true } as unknown,
  });
}

// skills, agents, web, and release are conditional on their deps. Base =
// everything else. Full surface = all canonical tools.
const CONDITIONAL_TOOLS = ['skills', 'agents', 'web', 'report', 'release'] as const;
const BASE_TOOLS = BUILTIN_TOOLS.filter(
  (n) => !(CONDITIONAL_TOOLS as readonly string[]).includes(n),
);

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
    const stubSkillsDeps = {
      vfs: {
        async exists() { return false; },
        async readFile() { return ''; },
        async writeFile() { /* nop */ },
        async readdir() { return []; },
        async unlink() { /* nop */ },
        async mkdir() { /* nop */ },
      },
      recordInvoke() { /* nop */ },
      currentlyInvoked: () => [],
    };
    const stubReleases = {
      board: async () => ({ bindings: [], changes: [], checks: [], approvals: [], deployments: [] }),
      bindSource: async () => ({
        id: 'psb-test',
        kind: 'local' as const,
        label: 'test',
        repoUrl: null,
        defaultBranch: null,
        localDeviceId: null,
        localRoot: '/tmp/proteus',
        deployTarget: null,
        createdAt: 0,
        updatedAt: 0,
      }),
      create: async () => ({ id: 'pc-test' }),
      update: async () => ({ id: 'pc-test' }),
      transition: async () => ({ id: 'pc-test' }),
      recordCheck: async () => ({
        id: 'pcc-test',
        changeId: 'pc-test',
        name: 'check',
        status: 'passed' as const,
        stdout: null,
        stderr: null,
        durationMs: null,
        createdAt: 0,
        updatedAt: 0,
      }),
      requestApproval: async () => ({
        id: 'pca-test',
        changeId: 'pc-test',
        approvalType: 'apply' as const,
        argumentDigest: 'digest',
        decision: 'pending' as const,
        approvedBy: null,
        note: null,
        createdAt: 0,
        decidedAt: null,
      }),
      recordDeployment: async () => ({
        id: 'pcd-test',
        changeId: 'pc-test',
        environment: 'staging' as const,
        workerVersionId: null,
        deploymentId: null,
        rollbackTarget: null,
        deployedAt: 0,
      }),
    };
    const stubWebSearch = {
      search: async (query: string) => ({ query, results: [], source: 'duckduckgo' as const }),
      fetch: async (url: string) => ({ url, retrievedAt: new Date().toISOString(), markdown: '' }),
    };
    const stubHandoff = {
      eventId: 'evt-1', delivery: 'starts_now' as const,
      phase: { busy: false, lastActivityAt: null, workingOn: null },
    };
    const stubTeam = {
      list: async () => [],
      spawn: async () => ({ name: 's', displayName: 'S' }),
      assign: async () => ({ ok: true as const, name: 's', ...stubHandoff }),
      status: async () => ({}),
      message: async () => ({ ok: true as const, name: 's', ...stubHandoff }),
      dismiss: async () => ({ ok: true as const, name: 's', historyKept: false }),
    };
    const stubPeers = {
      listPeers: async () => [],
      ask: async () => ({ status: 'no_reply' as const, note: 'stub' }),
      send: async () => ({ status: 'queued' as const, message_id: 'm1' }),
      reply: async () => ({ ok: true as const }),
      spawnWorkspace: async () => ({ agent: 'a', created: true, status: 'no_reply' as const, note: 'stub' }),
    };
    const stubReport = {
      report: async () => ({ delivered: true }),
    };
    const t = buildBuiltinTools({
      rt,
      craftedToolExecute: nodeCraftedExecute,
      createExecuteTool: nodeExecFactory as never,
      codemodeLoader: { __test: true } as unknown,
      facts: stubFacts,
      skills: stubSkillsDeps,
      releases: stubReleases,
      webSearch: stubWebSearch,
      agents: { team: stubTeam, peers: stubPeers },
      report: stubReport,
    });
    const names = Object.keys(t);
    for (const canonical of BUILTIN_TOOLS) expect(names).toContain(canonical);
    expect(names.length).toBe(BUILTIN_TOOLS.length);
  });

  test('each tool carries description + inputSchema', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    for (const [, v] of Object.entries(t)) {
      const tool = v as { description?: string; inputSchema?: unknown };
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  test('descriptions document both codemode.* and tools.<name> namespaces', () => {
    // Preamble-pattern invariant: both namespaces are real.
    //   codemode.* dispatches over RPC into host-side provider fns.
    //   tools.<name> resolves locally inside the preamble-injected object
    //     literal (crafted tools, via PreambleCraftedExecutor).
    // Either can invoke a crafted tool; the prompt must advertise both.
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('codemode.*');
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('tools.');
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
    expect(typeof result).toBe('string');
  });

  test('memory keyed-fact actions round-trip through the facts store', async () => {
    const { rt } = createTestRuntime();
    const store = new Map<string, { key: string; value: unknown; confidence: number; source: string; lastObservedAt: number }>();
    const facts = {
      upsert: (key: string, value: unknown, opts?: { confidence?: number }) => {
        store.set(key, { key, value, confidence: opts?.confidence ?? 1, source: 'tool', lastObservedAt: 7 });
        return 'created' as const;
      },
      recall: (key: string) => store.get(key) ?? null,
      forget: (key: string) => { store.delete(key); },
      recentTopK: () => [], all: () => [],
    };
    const t = buildBuiltinTools({
      rt, craftedToolExecute: nodeCraftedExecute,
      createExecuteTool: nodeExecFactory as never, codemodeLoader: { __test: true } as unknown,
      facts,
    });
    const memory = { execute: toolExecute<Record<string, unknown>, Record<string, unknown>>(t.memory) };

    expect(await memory.execute({ action: 'remember', key: 'user.tz', value: 'UTC', confidence: 0.9 }))
      .toEqual({ ok: true, key: 'user.tz' });
    expect(await memory.execute({ action: 'recall', key: 'user.tz' })).toMatchObject({
      found: true, key: 'user.tz', value: 'UTC', confidence: 0.9,
    });
    expect(await memory.execute({ action: 'forget', key: 'user.tz' }))
      .toEqual({ ok: true, key: 'user.tz', existed: true });
    expect(await memory.execute({ action: 'recall', key: 'user.tz' })).toEqual({ found: false, key: 'user.tz' });

    // The pre-flight that keeps a non-serializable value from crashing the turn.
    const circular: Record<string, unknown> = {};
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
      createExecuteTool: nodeExecFactory as never, codemodeLoader: { __test: true } as unknown,
      facts: { upsert: () => 'created' as const, recall: () => null, forget: () => {}, recentTopK: () => [], all: () => [] },
    });
    expect((t.memory as { description: string }).description).toBe(BUILTIN_TOOL_DESCRIPTIONS.memory);
  });

  test('without a facts store the keyed-fact actions are not on the schema', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const schema = (t.memory as unknown as { inputSchema: { jsonSchema: { properties: { action: { enum: string[] } } } } })
      .inputSchema.jsonSchema;
    expect(schema.properties.action.enum).toEqual(['save', 'search', 'sessions']);
    // ...and the docstring does not advertise what the runtime cannot do.
    expect((t.memory as { description: string }).description).not.toContain('remember');
  });

  // The release lane has two halves and no actor has both: an engine EARNS
  // apply/run_checks/preview/deploy/rollback from real command output and
  // refuses the record_* twins as assertions; without one the record_* actions
  // are the only way the ledger learns what the agent ran itself. The schema
  // gates on the same dep the runtime does, so neither actor reads the other's.
  const releaseLedgerDeps = {
    board: async () => ({}), bindSource: async () => ({}), create: async () => ({}),
    update: async () => ({}), transition: async () => ({}), recordCheck: async () => ({}),
    requestApproval: async () => ({}), recordDeployment: async () => ({}),
  };
  const releaseSchema = (releases: unknown) => {
    const { rt } = createTestRuntime();
    const t = buildBuiltinTools({
      rt, craftedToolExecute: nodeCraftedExecute,
      createExecuteTool: nodeExecFactory as never, codemodeLoader: { __test: true } as unknown,
      releases: releases as never,
    });
    const release = t.release as unknown as {
      description: string;
      inputSchema: { jsonSchema: { properties: Record<string, { enum?: string[] }> } };
    };
    return { description: release.description, properties: release.inputSchema.jsonSchema.properties };
  };

  test('with an execution engine the release surface offers only what execution earns', () => {
    const { description, properties } = releaseSchema({
      ...releaseLedgerDeps,
      engine: {
        apply: async () => ({}), runChecks: async () => ({}), preview: async () => ({}),
        deploy: async () => ({}), rollback: async () => ({}),
      },
    });
    expect(properties.action!.enum).toEqual([
      'board', 'bind_source', 'create', 'update', 'transition', 'request_approval',
      'apply', 'run_checks', 'preview', 'deploy', 'rollback',
    ]);
    // The states the engine earns are refused as manual transitions, so they
    // are not offered as ones either.
    expect(properties.status!.enum).toEqual(['draft', 'planning', 'patching', 'awaiting_approval', 'rejected', 'failed']);
    // The asserted-check input belongs to the ledger-only half.
    expect(properties.check).toBeUndefined();
    expect(description).toBe(BUILTIN_TOOL_DESCRIPTIONS.release);
  });

  test('without an execution engine the release surface is the ledger, and says so', () => {
    const { description, properties } = releaseSchema(releaseLedgerDeps);
    expect(properties.action!.enum).toEqual([
      'board', 'bind_source', 'create', 'update', 'transition', 'request_approval',
      'record_check', 'record_deployment',
    ]);
    // Every status is reachable here: nothing else is going to earn one.
    expect(properties.status!.enum).toContain('deployed');
    expect(properties.check).toBeDefined();
    // ...and the driven-execution inputs are absent, as is their doctrine.
    expect(properties.checks).toBeUndefined();
    expect(properties.port).toBeUndefined();
    expect(properties.startCommand).toBeUndefined();
    expect(description).not.toContain('run_checks');
  });

  test('run in workspace mode falls back gracefully when no shell provided', async () => {
    // Test runtime has no rt.shell — `run` must return an error string rather
    // than throwing. This lets test harnesses exercise the tool shape without
    // providing a real shell dependency.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = { execute: toolExecute<{ command: string }, string>(t.run) };
    const result = await tool.execute({ command: 'echo hi' });
    expect(typeof result).toBe('string');
    expect(result).toContain('Error');
  });

  test('run with an unprovisioned runtime returns structured runtime_not_provisioned', async () => {
    // The UI parses this exact JSON shape (parseProvisionError in
    // WorkspacePage.tsx) to render the amber install-card. Silent fallback to
    // workspace would defeat the install-card flow, so the contract is:
    // `{error:'runtime_not_provisioned', runtime, message}`.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = { execute: toolExecute<{ command: string; runtime?: string }, string>(t.run) };
    for (const runtime of ['sandbox', 'nimbus', 'laptop'] as const) {
      const result = await tool.execute({ command: 'echo hi', runtime });
      const parsed = JSON.parse(result) as { error: string; runtime: string; message: string };
      expect(parsed.error).toBe('runtime_not_provisioned');
      expect(parsed.runtime).toBe(runtime);
      expect(typeof parsed.message).toBe('string');
      expect(parsed.message.length).toBeGreaterThan(0);
    }
  });

  test('gated run commands return an error the MODEL can act on', async () => {
    // Regression: the gate message used to tell the model to call
    // setShellApprovalMode('allow_all') — a backend RPC the model cannot
    // reach. The actionable path is asking the user.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = { execute: toolExecute<{ command: string }, string>(t.run) };
    const result = await tool.execute({ command: 'sudo whoami' });
    expect(result).toContain('Requires user approval (mode=strict)');
    expect(result).toContain('Ask the user');
    expect(result).not.toContain('setShellApprovalMode');
  });

  test('execute_tools exposes workspace and codemode globals', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = { execute: toolExecute<{ code: string }, { result: unknown }>(t.execute_tools) };
    const result = await tool.execute({
      code: "return typeof workspace + ',' + typeof codemode;",
    });
    expect(result.result).toBe('object,object');
  });

  test('crafted tools become bare callables under codemode.<name>', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'double', description: 'doubles a number', params: null,
      code: 'async (x) => x * 2', scope: 'local',
    });

    const t = tools(rt);
    const tool = { execute: toolExecute<{ code: string }, { result: unknown }>(t.execute_tools) };
    const result = await tool.execute({ code: 'return await codemode.double(21);' });
    expect(result.result).toBe(42);
  });

  test('low-scoring crafted tools filtered out of codemode namespace', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'weak', description: 'low quality', params: null,
      code: 'async () => "should never run"', scope: 'local',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, last_used_at) VALUES ('weak', 0.01, ${Date.now()})`;

    const t = tools(rt);
    const tool = { execute: toolExecute<{ code: string }, { result: unknown }>(t.execute_tools) };
    const result = await tool.execute({ code: 'return typeof codemode.weak;' });
    expect(result.result).toBe('undefined');
  });

  // v2.1(E): same-turn codemode.<name> for a NEW tool is no longer supported.
  // The Proxy live-lookup path used host-side new Function and was removed.
  // Tools created this turn become available next turn (getTools rebuilds).
});
