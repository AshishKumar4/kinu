// quiet-cove, production 2026-10-25: every turn held 53 GitHub MCP tools, which only `codemode.list` inside `eval` named,
// and the agent, never asking, told the owner GitHub was read-only. A turn's context now names each connected server and
// how many of its tools change things, counted from the very surface its programs' `codemode.list` answers from.
import { describe, expect, test } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import * as v from 'valibot';
import { createMemoryVfs, createTestActors, createTestRuntime, createTestSql, present } from '@kinu.run/test-utils';
import { buildMcpToolSet, type SerializableToolDescriptor } from '../src/tools/mcp-surface';
import { collectDynamicContext } from '../src/state/dynamic-context';
import { createAgentStores } from '../src/state/agent-stores';
import { initWorkspaceSchema } from '../src/state/workspace-schema';
import { initToolEffectClaimTable } from '../src/tools/effect-claim';
import { narrowToolSurface, programSurface } from '../src/index';
import { renderDynamicContextBlock } from '../src/prompting/volatile-context';
import { permitInPlan } from '../src/execution/work-mode';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { makeSqlExec } from './helpers';

const descriptor = (serverName: string, name: string, readOnly: boolean): SerializableToolDescriptor => ({
  serverId: serverName.toLowerCase(), serverName, name, toolKey: `mcp_${serverName}_${name}`,
  description: `${name} on ${serverName}`, inputSchema: { type: 'object' }, ...(readOnly && { readOnly: true }),
});

/** Two servers as a backend serves them: one that writes, one that only reads. */
function connected(): ToolSet {
  const { sql, execRaw } = createTestSql();

  initToolEffectClaimTable(execRaw);

  return buildMcpToolSet([
    descriptor('GitHub', 'list_issues', true), descriptor('GitHub', 'issue_read', true),
    descriptor('GitHub', 'issue_write', false), descriptor('GitHub', 'add_issue_comment', false),
    descriptor('Docs', 'search_docs', true),
  ], {
    call: async () => 'answered',
    effectClaims: { sql, actor: createTestActors(sql, execRaw).main, execution: () => ({ turnId: 't', runId: 'r' }), durable: () => Promise.resolve() },
    spill: { vfs: createMemoryVfs().vfs, home: WORKSPACE_ROOT },
  });
}

const EVAL = permitInPlan(tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ran' }));

/** The turn's context as both backends collect it, rendered as the model reads it. */
function told(external: ToolSet, allowedTools: readonly string[] = ['eval']) {
  const { rt, testSql } = createTestRuntime();

  initWorkspaceSchema({ execRaw: testSql.execRaw, sql: testSql.sql, exec: makeSqlExec(testSql.db), transactionSync: (write) => rt.storage.transactionSync(write) });
  const stores = createAgentStores(() => testSql.sql, () => rt.actor, (write) => rt.storage.transactionSync(write), async () => ({ vfs: rt.storage.vfs, artifactDirectory: '/actor/.kinu/context' }));

  const context = collectDynamicContext({
    rt, stores, profile: { workMode: 'build', allowedTools: [...allowedTools] }, tools: { eval: EVAL }, externalTools: external,
    runtime: { backend: 'cf', model: { id: 'model' }, date: '2026-10-25' }, memoryTail: undefined, missingCapabilities: [],
  });

  return { context, block: present(renderDynamicContextBlock(context), 'the dynamic context block') };
}

/** What a program's `codemode.list(server)` answers, as `eval` builds it. */
async function listed(external: ToolSet, server: string): Promise<readonly string[]> {
  const { providers } = programSurface({ surface: { native: {}, external: () => external }, namespaces: [], reach: narrowToolSurface(undefined), mode: 'build', signal: undefined, crafted: [] });
  const codemode = present(providers.find((provider) => provider.name === 'codemode'), 'the codemode namespace');
  const answer = await present(codemode.tools.list, 'codemode.list').execute(server);

  return v.parse(v.array(v.object({ path: v.string() })), answer).map((row) => row.path);
}

describe('a turn is told its connected services, as its programs reach them', () => {
  test('each server, its tools and those that change things, counted as `codemode.list` answers them', async () => {
    const external = connected();
    const reads = new Set(['tools.mcp_GitHub_list_issues', 'tools.mcp_GitHub_issue_read']);
    const github = await listed(external, 'GitHub');

    expect(told(external).context.connections).toEqual([
      { server: 'GitHub', tools: github.length, changing: github.filter((path) => !reads.has(path)).length },
      { server: 'Docs', tools: (await listed(external, 'Docs')).length, changing: 0 },
    ]);
  });

  test('no tool of theirs is named before a program asks: the catalog stays inside eval', () => {
    const { block } = told(connected());

    expect(['mcp_GitHub_', 'issue_write', 'mcp_Docs_'].filter((name) => block.includes(name))).toEqual([]);
    expect(block).toContain('GitHub');
  });

  test('a turn that cannot run `eval` is told no server, which no call of its could reach', () => {
    expect(told(connected(), []).context.connections ?? []).toEqual([]);
  });
});
