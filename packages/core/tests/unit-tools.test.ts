/**
 * Unit tests for the canonical tool surface.
 *
 * The agent's tool surface is deliberately SMALL (fewer tools → better LLM
 * selection). Always-on (no extra deps): execute_tools, run, memory.
 * Conditional (needs a specific dep in BuiltinToolDeps):
 *   - skills           ← skills (SkillsToolDeps — vfs + invoke tracker)
 *   - think            ← thinkTool (StrategyRegistry; subsumes the old bare
 *                        `explore` + `split_heads` tools via strategy ids)
 *   - fact             ← facts (FactsStore; remember/recall/forget actions)
 *   - product_change   ← productChanges (source bindings + approvals store)
 *
 * BUILTIN_TOOLS lists every canonical name so crafted-tool filtering
 * (BUILT_IN_TOOL_NAMES) excludes them all from craft suggestions, regardless
 * of whether the runtime happens to wire the conditional dep.
 */

import { describe, test, expect } from 'bun:test';
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
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
}) => {
  const codemode: Record<string, (arg: unknown) => Promise<unknown>> = {};
  for (const [n, e] of Object.entries(opts.tools)) {
    codemode[n] = e.execute as (arg: unknown) => Promise<unknown>;
  }
  return tool({
    description: 'test exec_tools',
    inputSchema: jsonSchema<{ code: string }>({
      type: 'object', properties: { code: { type: 'string' } }, required: ['code'],
    }),
    execute: async (a: { code: string }) => {
      try {
        const fn = new Function('workspace', 'codemode', 'return (async () => { ' + a.code + ' })()');
        const result = await fn({}, codemode);
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

// skills, think, fact, and product_change are conditional on their deps. Base = everything
// else. Full surface = all canonical tools.
const CONDITIONAL_TOOLS = ['skills', 'think', 'fact', 'web_search', 'web_fetch', 'team', 'peers', 'report', 'product_change'] as const;
const BASE_TOOLS = BUILTIN_TOOLS.filter(
  (n) => !(CONDITIONAL_TOOLS as readonly string[]).includes(n),
);

describe('Agent tools (canonical surface — skills/think/fact conditional)', () => {
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
    const stubThink = tool({
      description: 'stub think',
      inputSchema: jsonSchema<{ strategy: string; task: string }>({
        type: 'object', properties: { strategy: { type: 'string' }, task: { type: 'string' } },
        required: ['strategy', 'task'],
      }),
      execute: async () => 'stub',
    });
    const stubFacts = {
      upsert: () => {}, recall: () => null, forget: () => {},
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
    const stubProductChanges = {
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
    const stubTeam = {
      list: async () => [],
      spawn: async () => ({ name: 's', displayName: 'S' }),
      assign: async () => ({ ok: true as const, name: 's' }),
      status: async () => ({}),
      message: async () => ({ ok: true as const, name: 's' }),
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
      thinkTool: stubThink,
      facts: stubFacts,
      skills: stubSkillsDeps,
      productChanges: stubProductChanges,
      webSearch: stubWebSearch,
      team: stubTeam,
      peers: stubPeers,
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
    const memoryTool = t.memory as {
      execute: (args: { action: 'save' | 'search'; content?: string; query?: string }) => Promise<string>;
    };

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

    const memoryTool = t.memory as {
      execute: (args: { action: 'save' | 'search'; content?: string; query?: string }) => Promise<string>;
    };
    const result = await memoryTool.execute({ action: 'search', query: 'machine learning' });
    expect(typeof result).toBe('string');
  });

  test('run in workspace mode falls back gracefully when no shell provided', async () => {
    // Test runtime has no rt.shell — `run` must return an error string rather
    // than throwing. This lets test harnesses exercise the tool shape without
    // providing a real shell dependency.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.run as { execute: (args: { command: string }) => Promise<string> };
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
    const tool = t.run as { execute: (args: { command: string; runtime?: string }) => Promise<string> };
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
    const tool = t.run as { execute: (args: { command: string }) => Promise<string> };
    const result = await tool.execute({ command: 'sudo whoami' });
    expect(result).toContain('Requires user approval (mode=strict)');
    expect(result).toContain('Ask the user');
    expect(result).not.toContain('setShellApprovalMode');
  });

  test('execute_tools exposes workspace and codemode globals', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.execute_tools as { execute: (args: { code: string }) => Promise<{ result: unknown }> };
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
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };
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
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };
    const result = await tool.execute({ code: 'return typeof codemode.weak;' });
    expect(result.result).toBe('undefined');
  });

  // v2.1(E): same-turn codemode.<name> for a NEW tool is no longer supported.
  // The Proxy live-lookup path used host-side new Function and was removed.
  // Tools created this turn become available next turn (getTools rebuilds).
});
