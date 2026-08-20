/**
 * Full E2E lifecycle test — real LLM, real bun:sqlite, native AI SDK tool
 * calling.
 *
 * Covers: agent creation, tool building, multi-turn chat with tool use,
 * close/reopen via openWorkspace, identity/SOUL.md/scaffold persistence.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, stepCountIs, type LanguageModel, type ToolSet, type StepResult } from 'ai';
import * as v from 'valibot';

import {
  buildBuiltinTools,
  BUILTIN_TOOLS,
  collectStepText,
  initWorkspaceSchema,
  readSoul,
  JsonObjectSchema,
  projectJsonValue,
  type AgentRuntime,
  type LLMProviderConfig,
  type CompletedTurn,
  type ToolCallRecord,
} from '../packages/core/src/index';
import { createWorkspace, openWorkspace } from '../packages/core/src/identity/index';
import { openWorkspaceCLI } from '../packages/cli-backend/src/open';
import { makeWorkspaceSchemaSql } from '../packages/cli-backend/src/runtime';
import { requireSandboxedExecutors } from './evals/harness';
import {
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend, UNCONFIGURED_LLM,
} from '@kinu/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('E2E Full Lifecycle');
const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'proteus-e2e-full-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

// ── Helpers ──────────────────────────────────────────────────────

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
  // BUG 1 fix: collect text from all steps when final step has no text
  const responseText = collectStepText(result);

  const id = crypto.randomUUID();
  void rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${id}, ${'e2e-full'}, ${'user'}, ${userMessage})`;
  void rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${'e2e-full'}, ${id}, ${'assistant'}, ${responseText})`;

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
  let model: LanguageModel;
  let agentId: string;
  let agentName: string;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');

    // BIRTH, then the WHOLE schema, then OPEN. The birth runtime carries no
    // `preBuilt` deps, so `execute_tools` answered every call with
    // "execute_tools is not configured on this runtime" — measured live, while
    // step 4 ("code execution") still passed, because it asserts only that the
    // reply is non-empty. `openWorkspaceCLI` builds `createCLIRuntime`, the same
    // spine `proteus exec` runs, so the tool the prompt names actually exists.
    await createWorkspace(db, {
      name: 'lifecycle-test',
      purpose: 'A coding assistant that helps write and test JavaScript code.',
      llm: LLM_CONFIG,
    });
    // One function declares a workspace's tables. The three calls this replaced
    // omitted `initShadowTables`, and a sibling suite died on the table it
    // creates 102s into a paid run.
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    // `hostRoot: null` keeps every executor off the repo this suite launched
    // from; the next line asserts that rather than trusting it.
    ({ rt } = await openWorkspaceCLI(db, DB_PATH, { llm: LLM_CONFIG, hostRoot: null }));
    requireSandboxedExecutors('e2e-full-lifecycle', rt);

    tools = buildBuiltinTools({ rt });
    model = liveChatModel(LLM_CONFIG);
    agentId = rt.identity.id;
    agentName = rt.identity.name;
  });

  afterAll(() => {
    reportLiveModelSpend('E2E Full Lifecycle');
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Step 1: Verify creation ──────────────────────────────────

  test('1. agent created with correct tables, SOUL.md, and identity', async () => {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(t => t.name);

    expect(tables).toContain('workspace_identity');
    expect(tables).toContain('messages');
    expect(tables).toContain('inodes');
    expect(tables).toContain('search_nodes');
    expect(tables).toContain('scaffold_versions');
    expect(tables).toContain('crafted_tools');
    expect(tables).toContain('fibers');

    const soul = await readSoul(rt.storage.vfs) ?? '';
    expect(soul).toContain('JavaScript');

    const identity = db.query<{ id: string; name: string }, []>(
      'SELECT id, name FROM workspace_identity LIMIT 1',
    ).get();
    if (!identity) throw new Error('workspace identity row was not created');
    expect(identity.id).toBeTruthy();
    expect(identity.name).toBe('lifecycle-test');

    console.log(`  Tables: ${tables.length}`);
    console.log(`  Identity: ${identity.id} (${identity.name})`);
    console.log(`  Soul: ${soul.slice(0, 60)}`);
  });

  // ── Step 2: Verify tools ─────────────────────────────────────

  // buildBuiltinTools is dep-gated: a tool appears only when the backend
  // supplied what it needs (skills store, facts store, agents fork/team/peer
  // deps...). This runtime wires only `rt`, so the assertion is
  // that the surface is exactly what those deps earn — never a stray name,
  // and never a tool whose backend is absent.
  test('2. buildBuiltinTools returns the dep-gated subset, all of it canonical', () => {
    const names = Object.keys(tools);
    // `toContain` will not match a plain `string` against BUILTIN_TOOLS' literal
    // union element type. Widening by assignment rather than by assertion — the
    // point of the check is that each built name IS one of those literals.
    const canonical: readonly string[] = BUILTIN_TOOLS;
    for (const name of names) expect(canonical).toContain(name);
    for (const core of ['execute_tools', 'run', 'file', 'memory']) expect(names).toContain(core);
    for (const ungated of ['skills', 'agents', 'release']) {
      expect(names).not.toContain(ungated);
    }
    console.log(`  Tools: ${names.join(', ')}`);
  });

  // ── Step 3: Chat turn 1 — simple, no tools ──────────────────

  liveTest('3. chat turn 1: simple math question', async () => {
    const turn = await chatTurn(model, rt, tools, 'What is 2+2? Answer briefly.');
    console.log(`  Response (${turn.assistantResponse.length} chars): ${turn.assistantResponse.slice(0, 120)}`);
    console.log(`  Steps: ${turn.steps}, Tools: ${turn.toolCalls.map(t => t.name).join(', ') || 'none'}`);
    expect(turn.assistantResponse.length).toBeGreaterThan(0);
    expect(turn.assistantResponse.toLowerCase()).toContain('4');
  }, 120_000);

  // ── Step 4: Chat turn 2 — should use execute_tools ──────────

  liveTest('4. chat turn 2: code execution', async () => {
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

  liveTest('5. chat turn 3: save note to memory', async () => {
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
    if (!memory) throw new Error('memory note was not persisted');
    console.log(`  Memory size: ${memory.length} chars`);
  }, 120_000);

  // ── Step 6: Close and reopen with openWorkspace ──────────────────

  liveTest('6. close and reopen agent — verify persistence', async () => {
    db.close();

    const db2 = new Database(DB_PATH);
    const { rt: rt2, info } = await openWorkspace(db2, { llm: LLM_CONFIG });

    // Identity survived
    expect(info.name).toBe(agentName);
    expect(info.purpose).toContain('JavaScript');

    // Runtime identity is properly reconstructed
    expect(rt2.identity).toBeDefined();
    expect(rt2.identity.id).toBe(agentId);
    expect(rt2.identity.name).toBe(agentName);

    // Scaffold survived
    expect(info.scaffoldVersion).toBeGreaterThanOrEqual(0);

    // Messages survived (at minimum: turns that completed × 2 messages each)
    const msgCount = db2.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
    expect(msgCount).toBeGreaterThanOrEqual(2); // at least 1 turn completed

    // SOUL.md survived
    expect(info.soul).toContain('JavaScript');

    console.log(`  Reopened agent: ${rt2.identity.id} (${info.name})`);
    console.log(`  Purpose: ${info.purpose.slice(0, 60)}`);
    console.log(`  Scaffold version: ${info.scaffoldVersion}`);
    console.log(`  Crafted tools: ${info.craftedToolCount}`);
    console.log(`  Search nodes: ${info.searchNodeCount}`);
    console.log(`  Tasks: ${info.taskCount}`);
    console.log(`  Memory size: ${info.memorySize} bytes`);
    console.log(`  Messages: ${msgCount}`);

    // Replace db reference for cleanup
    db = db2;
    rt = rt2;
  });

  // ── Step 7: Print full DB state summary ──────────────────────

  liveTest('7. full database state summary', async () => {
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(t => t.name);

    console.log('\n  ═══ DATABASE STATE SUMMARY ═══');
    console.log(`  Tables: ${tables.join(', ')}`);

    for (const table of tables) {
      const count = db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM "${table}"`).get()?.c ?? 0;
      if (count > 0) console.log(`  ${table}: ${count} rows`);
    }

    const identity = db.query<{ id: string; name: string }, []>(
      'SELECT id, name FROM workspace_identity',
    ).get();
    console.log(`\n  Identity: ${JSON.stringify(identity)}`);

    const soul = await readSoul(rt.storage.vfs) ?? '';
    console.log(`  SOUL.md: ${JSON.stringify(soul.slice(0, 120))}`);

    const vfsFiles = db.query<{ path: string; size: number }, []>(
      'SELECT path, size FROM inodes WHERE kind = 0 ORDER BY path',
    ).all();
    console.log(`\n  VFS files:`);
    for (const f of vfsFiles) console.log(`    ${f.path} (${f.size} bytes)`);

    const messages = db.query<{ role: string; preview: string }, []>(
      'SELECT role, substr(content, 1, 80) as preview FROM messages ORDER BY created_at',
    ).all();
    console.log(`\n  Messages (${messages.length}):`);
    for (const m of messages) console.log(`    [${m.role}] ${m.preview}...`);

    console.log('  ═══ END SUMMARY ═══\n');

    expect(tables.length).toBeGreaterThan(0);
  });
});
