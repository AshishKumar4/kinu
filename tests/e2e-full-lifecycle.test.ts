/**
 * Full E2E lifecycle test — real LLM (Kimi K2.5 via AI Gateway),
 * real bun:sqlite, native AI SDK tool calling.
 *
 * Covers: agent creation, tool building, multi-turn chat with tool use,
 * close/reopen via openAgent, identity/soul/scaffold persistence.
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
  openAgent,
  buildBuiltinTools,
  BUILTIN_TOOLS,
  EvolutionEngine,
  collectStepText,
  initSearchTables,
  initScaffoldTables,
  initCraftScoreTables,
  type AgentRuntime,
  type LLMProviderConfig,
  type CompletedTurn,
  type ToolCallRecord,
} from '../packages/core/src/index.js';

// ── Config ───────────────────────────────────────────────────────

const LLM_CONFIG: LLMProviderConfig = {
  name: 'workers-ai',
  baseURL: process.env.PROTEUS_BASE_URL || 'https://gateway.ai.cloudflare.com/v1/fc895c5670cff9268b310a6a86bb6c35/orange-build-gateway/workers-ai/v1',
  headers: { 'cf-aig-authorization': process.env.PROTEUS_AUTH || '' },
  model: '@cf/moonshotai/kimi-k2.5',
};

const TEST_DIR = join(tmpdir(), 'proteus-e2e-full-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

// ── Helpers ──────────────────────────────────────────────────────

function createModel() {
  const provider = createOpenAICompatible({
    name: LLM_CONFIG.name,
    baseURL: LLM_CONFIG.baseURL,
    headers: LLM_CONFIG.headers,
  });
  return provider.chatModel(LLM_CONFIG.model);
}

async function chatTurn(
  model: ReturnType<typeof createModel>,
  rt: AgentRuntime,
  tools: ToolSet,
  userMessage: string,
): Promise<CompletedTurn> {
  const start = Date.now();
  const soul = rt.storage.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`[0]?.purpose ?? '';
  const knowledge = (await rt.memory.read('memory/MEMORY.md'))?.slice(0, 1500) ?? '';

  const tcRecords: ToolCallRecord[] = [];
  let stepCount = 0;

  const result = await generateText({
    model,
    system: [
      soul,
      `\nKnowledge:\n${knowledge}`,
      `\nAfter using any tools, always provide a text summary of what you did and the results.`,
    ].join(''),
    messages: [{ role: 'user' as const, content: userMessage }],
    tools,
    stopWhen: stepCountIs(500),
    onStepFinish: (step: StepResult<ToolSet>) => {
      stepCount++;
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

  // BUG 1 fix: collect text from all steps when final step has no text
  const responseText = collectStepText(result);

  const id = crypto.randomUUID();
  rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${id}, ${'e2e-full'}, ${'user'}, ${userMessage})`;
  rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${'e2e-full'}, ${id}, ${'assistant'}, ${responseText})`;

  return {
    userMessage,
    assistantResponse: responseText,
    toolCalls: tcRecords,
    steps: stepCount,
    durationMs: Date.now() - start,
    feedback: null,
    hadError: false,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('E2E Full Lifecycle', () => {
  let db: InstanceType<typeof Database>;
  let rt: AgentRuntime;
  let tools: ToolSet;
  let model: ReturnType<typeof createModel>;
  let agentId: string;
  let agentName: string;

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');

    rt = createAgent(db, {
      name: 'lifecycle-test',
      purpose: 'A coding assistant that helps write and test JavaScript code.',
      llm: LLM_CONFIG,
    });
    initSearchTables(rt.storage.execRaw);
    initScaffoldTables(rt.storage.execRaw);
    initCraftScoreTables(rt.storage.execRaw);

    tools = buildBuiltinTools({ rt, engine: new EvolutionEngine(rt, { enabled: false }) });
    model = createModel();
    agentId = rt.identity.id;
    agentName = rt.identity.name;
  });

  afterAll(() => {
    try { db.close(); } catch {}
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Step 1: Verify creation ──────────────────────────────────

  test('1. agent created with correct tables, soul, and identity', () => {
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(t => t.name);

    expect(tables).toContain('agent_identity');
    expect(tables).toContain('agent_soul');
    expect(tables).toContain('messages');
    expect(tables).toContain('vfs_files');
    expect(tables).toContain('search_nodes');
    expect(tables).toContain('scaffold_versions');
    expect(tables).toContain('crafted_tools');
    expect(tables).toContain('fibers');

    const soul = db.query('SELECT purpose FROM agent_soul LIMIT 1').get() as { purpose: string };
    expect(soul.purpose).toContain('JavaScript');

    const identity = db.query('SELECT id, name FROM agent_identity LIMIT 1').get() as { id: string; name: string };
    expect(identity.id).toBeTruthy();
    expect(identity.name).toBe('lifecycle-test');

    console.log(`  Tables: ${tables.length}`);
    console.log(`  Identity: ${identity.id} (${identity.name})`);
    console.log(`  Soul: ${soul.purpose.slice(0, 60)}`);
  });

  // ── Step 2: Verify tools ─────────────────────────────────────

  test('2. buildBuiltinTools returns the 5 canonical tools', () => {
    const names = Object.keys(tools);
    for (const canonical of BUILTIN_TOOLS) expect(names).toContain(canonical);
    expect(names.length).toBe(5);
    console.log(`  Tools: ${names.join(', ')}`);
  });

  // ── Step 3: Chat turn 1 — simple, no tools ──────────────────

  test('3. chat turn 1: simple math question', async () => {
    const turn = await chatTurn(model, rt, tools, 'What is 2+2? Answer briefly.');
    console.log(`  Response (${turn.assistantResponse.length} chars): ${turn.assistantResponse.slice(0, 120)}`);
    console.log(`  Steps: ${turn.steps}, Tools: ${turn.toolCalls.map(t => t.name).join(', ') || 'none'}`);
    expect(turn.assistantResponse.length).toBeGreaterThan(0);
    expect(turn.assistantResponse.toLowerCase()).toContain('4');
  }, 120_000);

  // ── Step 4: Chat turn 2 — should use execute_tools ──────────

  test('4. chat turn 2: code execution', async () => {
    const turn = await chatTurn(
      model, rt, tools,
      'Write a JS function to check if a number is prime, then test it with 7, 10, and 13. Use the execute_tools tool.',
    );
    console.log(`  Response (${turn.assistantResponse.length} chars): ${turn.assistantResponse.slice(0, 200)}`);
    console.log(`  Steps: ${turn.steps}, Tools: ${turn.toolCalls.map(t => t.name).join(', ') || 'none'}`);

    // Response should be non-empty even if last step was a tool call
    expect(turn.assistantResponse.length).toBeGreaterThan(0);

    if (turn.toolCalls.length > 0) {
      console.log(`  Tool calls: ${turn.toolCalls.length}`);
      for (const tc of turn.toolCalls) {
        console.log(`    ${tc.name}: ${JSON.stringify(tc.args ?? {}).slice(0, 100)}`);
      }
    }
  }, 300_000);

  // ── Step 5: Chat turn 3 — should use save_note ──────────────

  test('5. chat turn 3: save note to memory', async () => {
    const turn = await chatTurn(
      model, rt, tools,
      'Remember this important fact: the project uses bun:sqlite for its database layer. Use the save_note tool.',
    );
    console.log(`  Response (${turn.assistantResponse.length} chars): ${turn.assistantResponse.slice(0, 200)}`);
    console.log(`  Steps: ${turn.steps}, Tools: ${turn.toolCalls.map(t => t.name).join(', ') || 'none'}`);

    // Response should be non-empty even if last step was a tool call
    expect(turn.assistantResponse.length).toBeGreaterThan(0);

    // Verify memory was updated
    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toBeTruthy();
    console.log(`  Memory size: ${memory!.length} chars`);
  }, 120_000);

  // ── Step 6: Close and reopen with openAgent ──────────────────

  test('6. close and reopen agent — verify persistence', () => {
    db.close();

    const db2 = new Database(DB_PATH);
    const { rt: rt2, info } = openAgent(db2, { llm: LLM_CONFIG });

    // Identity survived
    expect(info.id).toBe(agentId);
    expect(info.name).toBe(agentName);
    expect(info.purpose).toContain('JavaScript');

    // Runtime identity is properly reconstructed
    expect(rt2.identity).toBeDefined();
    expect(rt2.identity.id).toBe(agentId);
    expect(rt2.identity.name).toBe(agentName);

    // Scaffold survived
    expect(info.scaffoldVersion).toBeGreaterThanOrEqual(0);

    // Messages survived (at minimum: turns that completed × 2 messages each)
    const msgCount = (db2.query('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    expect(msgCount).toBeGreaterThanOrEqual(2); // at least 1 turn completed

    // Soul survived
    const soul = (db2.query('SELECT purpose FROM agent_soul LIMIT 1').get() as { purpose: string });
    expect(soul.purpose).toContain('JavaScript');

    console.log(`  Reopened agent: ${info.id} (${info.name})`);
    console.log(`  Purpose: ${info.purpose.slice(0, 60)}`);
    console.log(`  Scaffold version: ${info.scaffoldVersion}`);
    console.log(`  Crafted tools: ${info.craftedToolCount}`);
    console.log(`  Search nodes: ${info.searchNodeCount}`);
    console.log(`  Tasks: ${info.taskCount}`);
    console.log(`  Memory size: ${info.memorySize} bytes`);
    console.log(`  Messages: ${msgCount}`);

    // Replace db reference for cleanup
    db = db2;
  });

  // ── Step 7: Print full DB state summary ──────────────────────

  test('7. full database state summary', () => {
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(t => t.name);

    console.log('\n  ═══ DATABASE STATE SUMMARY ═══');
    console.log(`  Tables: ${tables.join(', ')}`);

    for (const table of tables) {
      try {
        const count = (db.query(`SELECT COUNT(*) as c FROM "${table}"`).get() as { c: number }).c;
        if (count > 0) console.log(`  ${table}: ${count} rows`);
      } catch {}
    }

    const identity = db.query('SELECT * FROM agent_identity').get() as Record<string, unknown>;
    console.log(`\n  Identity: ${JSON.stringify(identity)}`);

    const soul = db.query('SELECT * FROM agent_soul').get() as Record<string, unknown>;
    console.log(`  Soul: ${JSON.stringify(soul)}`);

    const vfsFiles = (db.query('SELECT path, size FROM vfs_files ORDER BY path').all() as { path: string; size: number }[]);
    console.log(`\n  VFS files:`);
    for (const f of vfsFiles) console.log(`    ${f.path} (${f.size} bytes)`);

    const messages = (db.query('SELECT role, substr(content, 1, 80) as preview FROM messages ORDER BY created_at').all() as { role: string; preview: string }[]);
    console.log(`\n  Messages (${messages.length}):`);
    for (const m of messages) console.log(`    [${m.role}] ${m.preview}...`);

    console.log('  ═══ END SUMMARY ═══\n');

    expect(tables.length).toBeGreaterThan(0);
  });
});
