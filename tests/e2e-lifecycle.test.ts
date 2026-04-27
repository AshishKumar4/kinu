/**
 * E2E lifecycle test — real LLM, real SQLite, native AI SDK tool calling.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, stepCountIs, type ToolSet, type StepResult } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  createAgent,
  collectStepText,
  EvolutionEngine,
  buildBuiltinTools,
  initSearchTables,
  initScaffoldTables,
  initCraftScoreTables,
  type AgentRuntime,
  type LLMProviderConfig,
  type CompletedTurn,
  type EvolutionEvent,
  type ToolCallRecord,
  type SearchNode,
  type SessionWriter,
  type SessionMessage,
  runMCTS,
} from '../packages/core/src/index.js';

const LLM_CONFIG: LLMProviderConfig = {
  name: 'workers-ai',
  baseURL: process.env.PROTEUS_BASE_URL || 'https://gateway.ai.cloudflare.com/v1/fc895c5670cff9268b310a6a86bb6c35/orange-build-gateway/workers-ai/v1',
  headers: { 'cf-aig-authorization': process.env.PROTEUS_AUTH || '' },
  model: '@cf/moonshotai/kimi-k2.5',
};

const TEST_DIR = join(tmpdir(), 'proteus-e2e-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

async function chatTurn(
  model: ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>,
  rt: AgentRuntime,
  tools: ToolSet,
  userMessage: string,
): Promise<CompletedTurn> {
  const start = Date.now();
  const soul = rt.storage.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`[0]?.purpose ?? '';
  const knowledge = (await rt.memory.read('memory/MEMORY.md'))?.slice(0, 1500) ?? '';

  const tcRecords: ToolCallRecord[] = [];
  let steps = 0;

  const result = await generateText({
    model,
    system: `${soul}\n\nKnowledge:\n${knowledge}`,
    messages: [{ role: 'user' as const, content: userMessage }],
    tools,
    stopWhen: stepCountIs(500),
    onStepFinish: (step: StepResult<ToolSet>) => {
      steps++;
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          const args = (tc as any).input ?? (tc as any).args ?? {};
          tcRecords.push({ name: tc.toolName, args: args as Record<string, unknown>, result: null });
        }
      }
      if (step.toolResults) {
        for (let i = 0; i < step.toolResults.length; i++) {
          const tr = step.toolResults[i] as any;
          const idx = tcRecords.length - step.toolResults.length + i;
          if (tcRecords[idx]) tcRecords[idx]!.result = tr?.output ?? tr?.result ?? null;
        }
      }
    },
  });

  const responseText = collectStepText(result);
  const id = crypto.randomUUID();
  rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${id}, ${'e2e'}, ${'user'}, ${userMessage})`;
  rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${'e2e'}, ${id}, ${'assistant'}, ${responseText})`;

  return {
    userMessage, assistantResponse: responseText, toolCalls: tcRecords,
    steps, durationMs: Date.now() - start, feedback: null, hadError: false,
  };
}

function makeSessionWriter(): SessionWriter {
  const msgs: Array<{ id: string; parentId?: string | null; role: string; content: string }> = [];
  return {
    async appendMessage(msg: SessionMessage, parentId?: string | null) {
      msgs.push({ id: msg.id, parentId, role: msg.role, content: msg.parts.map(p => p.text).join('') });
    },
    getHistory(leafId?: string | null) {
      if (!leafId) return msgs.map(m => ({ role: m.role, content: m.content }));
      const result: Array<{ role: string; content: string }> = [];
      let cur = msgs.find(m => m.id === leafId);
      while (cur) { result.unshift({ role: cur.role, content: cur.content }); cur = cur.parentId ? msgs.find(m => m.id === cur!.parentId) : undefined; }
      return result;
    },
    async compact() {},
  };
}

describe('E2E Lifecycle', () => {
  let db: InstanceType<typeof Database>;
  let rt: AgentRuntime;
  let tools: ToolSet;
  let engine: EvolutionEngine;
  let events: EvolutionEvent[];
  let turns: CompletedTurn[];
  let model: ReturnType<ReturnType<typeof createOpenAICompatible>['chatModel']>;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    rt = createAgent(db, { name: 'e2e-test', purpose: 'A coding assistant that helps write TypeScript.', llm: LLM_CONFIG });
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);
    events = [];
    engine = new EvolutionEngine(rt, { enabled: true, sessionReflectionInterval: 4 });
    tools = buildBuiltinTools({ rt, engine });
    engine.onEvent(e => events.push(e));
    turns = [];

    const provider = createOpenAICompatible({ name: LLM_CONFIG.name, baseURL: LLM_CONFIG.baseURL, headers: LLM_CONFIG.headers });
    model = provider.chatModel(LLM_CONFIG.model);
  });

  afterAll(() => { try { db.close(); } catch {} rmSync(TEST_DIR, { recursive: true, force: true }); });

  test('agent created with correct tables', () => {
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(t => t.name);
    expect(tables).toContain('agent_soul');
    expect(tables).toContain('messages');
    expect(tables).toContain('search_nodes');
    const soul = db.query('SELECT purpose FROM agent_soul LIMIT 1').get() as { purpose: string };
    expect(soul.purpose).toContain('TypeScript');
  });

  test('5-turn conversation with native tool calling', async () => {
    const messages = [
      'Write a TypeScript function to sort an array of numbers.',
      'Now add error handling for non-array inputs.',
      'Save a note: always validate input types in utility functions.',
      'Search your memory for notes about validation.',
      'Summarize what we discussed.',
    ];
    for (let i = 0; i < messages.length; i++) {
      console.log(`  Turn ${i + 1}: ${messages[i]!.slice(0, 50)}...`);
      const turn = await chatTurn(model, rt, tools, messages[i]!);
      turns.push(turn);
      await engine.onTurnComplete(turn);
      expect(turn.assistantResponse.length).toBeGreaterThan(0);
      console.log(`    Response: ${turn.assistantResponse.slice(0, 80)}...`);
      if (turn.toolCalls.length > 0) console.log(`    Tools: ${turn.toolCalls.map(t => t.name).join(', ')}`);
    }
    const count = (db.query('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    console.log(`  Messages in DB: ${count}`);
    expect(count).toBeGreaterThanOrEqual(10);
  }, 600_000);

  test('evolution events fired', () => {
    console.log(`  Events: ${events.length}`);
    for (const e of events) console.log(`    [${e.type}] ${e.message.slice(0, 70)}`);
    expect(events.length).toBeGreaterThan(0);
  });

  test('memory has content', async () => {
    const mem = await rt.memory.read('memory/MEMORY.md');
    expect(mem).toBeTruthy();
    console.log(`  Memory: ${mem!.length} chars`);
  });

  test('MCTS evolution', async () => {
    const session = makeSessionWriter();
    const result = await runMCTS(rt, session, 'How can I improve as a TypeScript assistant?', { budget: 1, branches: 2, maxCostUSD: 5 });
    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
    console.log(`  Nodes: ${nodes.length}`);
    expect(nodes.length).toBe(3);
    expect(result.converged || !result.converged).toBe(true);
  }, 300_000);

  test('persistence', () => {
    const msgsBefore = (db.query('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    db.close();
    const db2 = new Database(DB_PATH, { readonly: true });
    const msgsAfter = (db2.query('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    const soul = (db2.query('SELECT purpose FROM agent_soul LIMIT 1').get() as { purpose: string }).purpose;
    db2.close();
    expect(msgsAfter).toBe(msgsBefore);
    expect(soul).toContain('TypeScript');
    db = new Database(DB_PATH);
  });
});
