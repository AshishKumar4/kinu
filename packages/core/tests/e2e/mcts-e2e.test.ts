/**
 * E2E test: Real SQLite + Real LLM, full MCTS cycle.
 *
 * Requires env vars: AI_GATEWAY_BASE_URL, AI_GATEWAY_AUTH
 * Skips gracefully if not set.
 */

import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { isE2EConfigured, loadAIGatewayProviders } from './ai-gateway-llm';
import { runMCTS } from '../../src/mcts/engine';
import { initSearchTables } from '../../src/mcts/schemas';
import { initScaffoldTables } from '../../src/scaffold/schemas';
import { initCraftQualityColumns } from '../../src/craft/schemas';
import type { SearchNode } from '../../src/types/mcts';
import type { AgentRuntime, BranchHandle } from '../../src/types/agent-runtime';
import type { LLM } from '../../src/types/primitives';
import type { SessionWriter, SessionMessage } from '../../src/mcts/record-node';
import {
  makeSql,
  makeExecRaw,
  createMemoryVFS,
  createMemoryMemory,
  createMemoryCraftStore,
  createMockExecutor,
  createMemorySchedule,
} from '../helpers';

async function createE2ERuntime(llm: LLM, judgeLlm: LLM) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  const vfs = createMemoryVFS(db);
  const memory = createMemoryMemory(db, vfs);
  const craftStore = createMemoryCraftStore(db);
  const executor = createMockExecutor();
  const schedule = createMemorySchedule(db);

  await vfs.mkdir('scaffold', { recursive: true });
  await vfs.writeFile('scaffold/agent.js', 'initial');

  function createRealBranch(branchLLM: LLM): BranchHandle {
    return {
      async explore(priorHistory) {
        const context = priorHistory.map(m => `${m.role}: ${m.content}`).join('\n');
        const text = await branchLLM.complete(
          `You are an expert software engineer exploring one approach to solve a task.\n\n` +
          `Prior context:\n${context.slice(-500)}\n\n` +
          `Propose ONE specific concrete approach in 2-3 sentences. Be specific about what to change.`,
        );
        return { text };
      },
      async generateReflection(task) {
        return { text: await branchLLM.complete(
          `The approach to "${task}" didn't work well. ` +
          `In one sentence, what specifically went wrong and why?`,
        ) };
      },
    };
  }

  const rt: AgentRuntime = {
    storage: { vfs, sql, execRaw },
    memory, executor, llm, schedule,
    identity: {
      id: 'e2e-agent', name: 'e2e-test',
      scaffold: {
        path: 'scaffold/agent.js',
        exists: () => vfs.exists('scaffold/agent.js'),
        read: async () => v.parse(v.string(), await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })),
        write: (code) => vfs.writeFile('scaffold/agent.js', code),
        version: async () => (sql<{ v: number }>`SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`)[0]?.v ?? 0,
      },
    },
    craftStore,
    judgeModel: judgeLlm,
    spawnBranch: async () => createRealBranch(llm),
    abortBranch: async () => {},
    releaseBranch: async () => {},
  };

  return { rt, db };
}

function createE2ESession(): SessionWriter {
  const messages: Array<{ id: string; parentId?: string | null; role: string; content: string }> = [];
  return {
    async appendMessage(msg: SessionMessage, parentId?: string | null) {
      messages.push({ id: msg.id, parentId, role: msg.role, content: msg.parts.map(p => p.text).join('') });
    },
    getHistory(leafId?: string | null) {
      if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
      const result: Array<{ role: string; content: string }> = [];
      let current = messages.find(m => m.id === leafId);
      while (current) {
        result.unshift({ role: current.role, content: current.content });
        const parentId = current.parentId;
        current = parentId ? messages.find(m => m.id === parentId) : undefined;
      }
      return result;
    },
  };
}

function printTree(db: Database) {
  const sql = makeSql(db);
  const nodes = sql<SearchNode & { action: string }>`
    SELECT id, parent_id, depth, visits, value, status, substr(action, 1, 80) as action
    FROM search_nodes ORDER BY depth, created_at`;

  console.log('\n--- MCTS SEARCH TREE ---');
  for (const n of nodes) {
    const indent = '  '.repeat(n.depth);
    const icon = n.status === 'open' ? 'O' : n.status === 'pruned' ? 'X' : n.status === 'terminal' ? 'V' : '!';
    console.log(`${indent}[${icon}] ${n.id.slice(0, 8)} v=${n.value.toFixed(3)} n=${n.visits} | ${n.action.replace(/\n/g, ' ').slice(0, 50)}`);
  }
  console.log('---');
}

describe.skipIf(!isE2EConfigured())('E2E MCTS with real LLM', () => {
  test('full search cycle', async () => {
    const { primary, judge } = loadAIGatewayProviders();
    const { rt, db } = await createE2ERuntime(primary, judge);

    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initCraftQualityColumns(rt.storage.execRaw, rt.storage.sql);

    const session = createE2ESession();
    const result = await runMCTS(rt, session, 'Write a function to validate email addresses', {
      budget: 1, branches: 2, maxCostUSD: 5,
    });

    printTree(db);

    const allNodes = makeSql(db)<SearchNode>`SELECT * FROM search_nodes`;
    console.log(`Tree: ${allNodes.length} nodes, converged=${result.converged}, winner=${result.winnerValue.toFixed(3)}`);

    expect(allNodes.length).toBe(3); // 1 root + 1 iteration * 2 branches
    const root = allNodes.find(n => n.parent_id === null);
    expect(root).toBeDefined();
    if (!root) throw new Error('MCTS root node was not persisted');
    expect(root.visits).toBeGreaterThan(0);

    for (const n of allNodes) {
      expect(n.value).toBeGreaterThanOrEqual(0);
      expect(n.value).toBeLessThanOrEqual(1);
    }

    const memory = await rt.memory.read('memory/MEMORY.md');
    if (result.converged) expect(memory).toContain('Successful approach');
    else expect(memory).toContain('Failed task');
  }, 600_000); // 10 min — reasoning models take 10-30s per call, AI Gateway has variable latency
});
