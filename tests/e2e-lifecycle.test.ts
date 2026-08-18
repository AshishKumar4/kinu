/**
 * E2E lifecycle test — real LLM, real SQLite, native AI SDK tool calling.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, stepCountIs, type LanguageModel, type ToolSet, type StepResult } from 'ai';
import * as v from 'valibot';

import {
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
  readSoul,
  JsonObjectSchema,
  projectJsonValue,
} from '../packages/core/src/index';
import { createWorkspace, openWorkspace } from '../packages/core/src/identity/index';
import {
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend, UNCONFIGURED_LLM,
} from '@proteus/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('E2E Lifecycle');
const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'proteus-e2e-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

async function chatTurn(
  model: LanguageModel,
  rt: AgentRuntime,
  tools: ToolSet,
  userMessage: string,
): Promise<CompletedTurn> {
  const start = Date.now();
  const soul = await readSoul(rt.storage.vfs) ?? '';
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
          tcRecords.push({
            name: tc.toolName,
            args: v.parse(JsonObjectSchema, tc.input),
            result: null,
          });
        }
      }
      if (step.toolResults) {
        for (let i = 0; i < step.toolResults.length; i++) {
          const toolResult = step.toolResults[i];
          const idx = tcRecords.length - step.toolResults.length + i;
          const record = tcRecords[idx];
          if (record && toolResult) record.result = projectJsonValue({ value: toolResult.output });
        }
      }
    },
  });

  recordLiveModelSpend(result.usage);
  const responseText = collectStepText(result);
  const id = crypto.randomUUID();
  void rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${id}, ${'e2e'}, ${'user'}, ${userMessage})`;
  void rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${'e2e'}, ${id}, ${'assistant'}, ${responseText})`;

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
      while (cur) {
        result.unshift({ role: cur.role, content: cur.content });
        const parentId = cur.parentId;
        cur = parentId ? msgs.find(m => m.id === parentId) : undefined;
      }
      return result;
    },
  };
}

describe('E2E Lifecycle', () => {
  let db: InstanceType<typeof Database>;
  let rt: AgentRuntime;
  let tools: ToolSet;
  let engine: EvolutionEngine;
  let events: EvolutionEvent[];
  let turns: CompletedTurn[];
  let model: LanguageModel;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    rt = await createWorkspace(db, { name: 'e2e-test', purpose: 'A coding assistant that helps write TypeScript.', llm: LLM_CONFIG });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initCraftScoreTables(rt.storage.execRaw);
    events = [];
    engine = new EvolutionEngine(rt, { enabled: true });
    tools = buildBuiltinTools({ rt });
    engine.onEvent(e => events.push(e));
    turns = [];

    model = liveChatModel(LLM_CONFIG);
  });

  afterAll(() => {
    reportLiveModelSpend('E2E Lifecycle');
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('agent created with correct tables', async () => {
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all().map(t => t.name);
    expect(tables).toContain('inodes');
    expect(tables).toContain('messages');
    expect(tables).toContain('search_nodes');
    const soul = await readSoul(rt.storage.vfs) ?? '';
    expect(soul).toContain('TypeScript');
  });

  liveTest('5-turn conversation with native tool calling', async () => {
    const messages = [
      'Write a TypeScript function to sort an array of numbers.',
      'Now add error handling for non-array inputs.',
      'Save a note: always validate input types in utility functions.',
      'Search your memory for notes about validation.',
      'Summarize what we discussed.',
    ];
    for (const [i, message] of messages.entries()) {
      console.log(`  Turn ${i + 1}: ${message.slice(0, 50)}...`);
      const turn = await chatTurn(model, rt, tools, message);
      turns.push(turn);
      await engine.reviewTurn(turn, null);
      expect(turn.assistantResponse.length).toBeGreaterThan(0);
      console.log(`    Response: ${turn.assistantResponse.slice(0, 80)}...`);
      if (turn.toolCalls.length > 0) console.log(`    Tools: ${turn.toolCalls.map(t => t.name).join(', ')}`);
    }
    const count = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
    console.log(`  Messages in DB: ${count}`);
    expect(count).toBeGreaterThanOrEqual(10);
  }, 600_000);

  liveTest('evolution events fired', () => {
    console.log(`  Events: ${events.length}`);
    for (const e of events) console.log(`    [${e.type}] ${e.message.slice(0, 70)}`);
    expect(events.length).toBeGreaterThan(0);
  });

  liveTest('memory has content', async () => {
    const mem = await rt.memory.read('memory/MEMORY.md');
    if (!mem) throw new Error('evolution did not write memory content');
    console.log(`  Memory: ${mem.length} chars`);
  });

  liveTest('MCTS evolution', async () => {
    const session = makeSessionWriter();
    const result = await runMCTS(rt, session, 'How can I improve as a TypeScript assistant?', { budget: 1, branches: 2, maxCostUSD: 5 });
    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
    console.log(`  Nodes: ${nodes.length}`);
    expect(nodes.length).toBe(3);
    expect(nodes.some((node) => node.id === result.winnerId)).toBe(true);
  }, 300_000);

  liveTest('persistence', async () => {
    const msgsBefore = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
    db.close();
    const db2 = new Database(DB_PATH);
    const msgsAfter = db2.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
    const reopened = await openWorkspace(db2, { llm: LLM_CONFIG });
    const soul = reopened.info.soul;
    db2.close();
    expect(msgsAfter).toBe(msgsBefore);
    expect(soul).toContain('TypeScript');
    db = new Database(DB_PATH);
  });
});
