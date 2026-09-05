/**
 * Full E2E lifecycle test — real LLM, real bun:sqlite, native AI SDK tool
 * calling.
 *
 * Covers: agent creation, tool building, multi-turn chat with tool use,
 * close/reopen via openWorkspaceCLI, identity/SOUL.md/scaffold persistence.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, stepCountIs, type LanguageModel, type ToolSet, type StepResult } from 'ai';
import * as v from 'valibot';

import {
  BUILTIN_TOOLS,
  collectStepText,
  createFactsStore,
  readSoul,
  type AgentRuntime,
  type LLMProviderConfig,
  type CompletedTurn,
} from '../packages/core/src/index';
import { openWorkspaceCLI } from '../packages/cli-backend/src/open';
import {
  makeSql, type CLIRuntime,
} from '../packages/cli-backend/src/runtime';
import {
  buildEvalAgentSurface, createStepToolCallLog,
} from './evals/harness';
import { provisionLocalTarget } from './evals/target-local';
import {
  finalIntegerAnswer,
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend, toolExecute,
  UNCONFIGURED_LLM,
} from '@kinu.run/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('E2E Full Lifecycle');
const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'kinu-e2e-full-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

/** The note steps 5 and 6 write and then read back. One constant, because a
 *  second copy of the string is a second thing that can drift out of step with
 *  the assertion that looks for it. */
const MEMORY_FACT = 'the project uses bun:sqlite for its database layer';

/**
 * WHERE the fact actually landed, across both memory write surfaces.
 *
 * `memory` offers two legitimate ways to store one: `save` appends to
 * `memory/MEMORY.md`, `remember` upserts a keyed row in `agent_facts`
 * (core/src/tools/memory-tool.ts:158-170). A prompt that says "save this fact"
 * admits either, so an assertion pinned to one of them measures which branch the
 * model picked and calls the other branch a failure.
 *
 * Measured 2026-08-24 against staging on `@cf/deepseek-ai/deepseek-v4-pro-0813`:
 * the model called `remember`, answered "stored under the key `project.database`
 * ... the result confirms `ok: true`", and step 5 failed on `action === 'save'`
 * having done exactly what it was asked. Step 6 then cascaded on the same
 * MEMORY.md read, and step 7 died with a `bun:sqlite` prepare error because step
 * 6 closes `db` before its own assertions run.
 *
 * So durability is asserted over BOTH surfaces and the chosen one is REPORTED,
 * never required. This suite's subject is that the note survives a close and
 * reopen; which tool action an agent reaches for is measured by the behaviour
 * arm's scorers, over a corpus, where one model's choice is a data point rather
 * than a gate.
 */
function storedMemoryFact(db: Database, memoryFile: string | null): string | null {
  if (memoryFile?.includes(MEMORY_FACT)) return 'memory/MEMORY.md';
  const fact = createFactsStore(makeSql(db)).all()
    .find((row) => JSON.stringify(row.value).includes(MEMORY_FACT));
  return fact ? `agent_facts[${fact.key}]` : null;
}

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

  const log = createStepToolCallLog();

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
    onStepFinish: (step: StepResult<ToolSet>) => { log.onStepFinish(step); },
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
    toolCalls: log.records,
    steps: log.steps,
    durationMs: Date.now() - start,
    feedback: null,
    hadError: false,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('E2E Full Lifecycle', () => {
  let db: InstanceType<typeof Database>;
  let rt: CLIRuntime;
  let tools: ToolSet;
  let model: LanguageModel;
  let agentId: string;
  let agentName: string;

  beforeAll(async () => {
    // Provisioned through the seam: birth, the whole schema, open, the
    // executor-surface and sandbox guards and the pre-turn profile — the same
    // sequence every live suite drives, once. The birth runtime carries no
    // `preBuilt` deps, so `execute_tools` answered every call with
    // "execute_tools is not configured on this runtime" — measured live, while
    // step 4 ("code execution") still passed, because it asserts only that the
    // reply is non-empty. `openWorkspaceCLI` builds `createCLIRuntime`, the
    // same spine `kinu exec` runs, so the tool the prompt names exists.
    // `db` and `rt` stay reassignable because step 6 closes and reopens the
    // store; afterAll below therefore still closes whichever handle is live.
    const target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'lifecycle-test',
      purpose: 'A coding assistant that helps write and test JavaScript code.',
      llm: LLM_CONFIG,
      model: liveChatModel(LLM_CONFIG),
      evolution: true,
    });
    db = target.db;
    rt = target.runtime;

    // Model first: the production actor root builds `agents` from deps carrying
    // the model a search expands with, so a surface built before it would be the
    // product's minus its delegation tool.
    model = liveChatModel(LLM_CONFIG);
    tools = buildEvalAgentSurface({ rt, model, llm: LLM_CONFIG }).tools;
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

  // The direct-generate eval uses the production actor factory and the local
  // runtime's real swarm dependency. Optional tools still appear only when
  // their dependencies exist.
  test('2. the live tool surface is canonical and executable', async () => {
    const names = Object.keys(tools);
    // `toContain` will not match a plain `string` against BUILTIN_TOOLS' literal
    // union element type. Widening by assignment rather than by assertion — the
    // point of the check is that each built name IS one of those literals.
    const canonical: readonly string[] = BUILTIN_TOOLS;
    for (const name of names) expect(canonical).toContain(name);
    for (const core of ['execute_tools', 'run', 'file', 'memory', 'agents']) {
      expect(names).toContain(core);
    }
    for (const ungated of ['skills', 'release']) expect(names).not.toContain(ungated);
    console.log(`  Tools: ${names.join(', ')}`);
    const execute = tools.execute_tools;
    if (!execute) throw new Error('execute_tools is absent');
    const result = await toolExecute<{ code: string }, unknown>(execute)({
      code: 'return 6 * 7;',
    });
    // Structural: the dispatcher answers `{result}`, the same shape the
    // harness-wiring and evolution-proof suites hold it to.
    expect(result).toEqual({ result: 42 });
  });

  // ── Step 3: Chat turn 1 — simple, no tools ──────────────────

  liveTest('3. chat turn 1: simple math question', async () => {
    const turn = await chatTurn(model, rt, tools, 'What is 2+2? Answer briefly.');
    console.log(`  Response (${turn.assistantResponse.length} chars): ${turn.assistantResponse.slice(0, 120)}`);
    console.log(`  Steps: ${turn.steps}, Tools: ${turn.toolCalls.map(t => t.name).join(', ') || 'none'}`);
    expect(turn.assistantResponse.length).toBeGreaterThan(0);
    // The extracted integer, not a substring: any '4' anywhere in the reply
    // would satisfy `toContain`, including one from the question's echo.
    expect(finalIntegerAnswer(turn.assistantResponse)).toBe(4);
  }, 120_000);

  // ── Step 4: Chat turn 2 — should use execute_tools ──────────

  liveTest('4. chat turn 2: code execution', async () => {
    const turn = await chatTurn(
      model, rt, tools,
      'Use execute_tools to write and run a JS prime checker for 7, 10, and 13. '
        + 'Print exactly JSON.stringify({7:true,10:false,13:true}), then summarize.',
    );
    console.log(`  Response (${turn.assistantResponse.length} chars): ${turn.assistantResponse.slice(0, 200)}`);
    console.log(`  Steps: ${turn.steps}, Tools: ${turn.toolCalls.map(t => t.name).join(', ') || 'none'}`);

    const execution = turn.toolCalls.find((call) => call.name === 'execute_tools');
    expect(execution, 'the model did not use execute_tools').toBeDefined();
    const output = v.parse(v.object({ logs: v.array(v.string()) }), execution?.result);
    expect(output.logs).toContain('{"7":true,"10":false,"13":true}');
    expect(turn.assistantResponse.length).toBeGreaterThan(0);
  }, 300_000);

  // ── Step 5: Chat turn 3 — persist a memory note ───────────────

  liveTest('5. chat turn 3: save note to memory', async () => {
    const turn = await chatTurn(
      model, rt, tools,
      `Use the memory tool to save this exact fact: ${MEMORY_FACT}`,
    );
    console.log(`  Response (${turn.assistantResponse.length} chars): ${turn.assistantResponse.slice(0, 200)}`);
    console.log(`  Steps: ${turn.steps}, Tools: ${turn.toolCalls.map(t => t.name).join(', ') || 'none'}`);

    const wrote = turn.toolCalls.find((call) => call.name === 'memory'
      && (call.args.action === 'save' || call.args.action === 'remember'));
    expect(wrote, 'the model never wrote through the memory tool — it called '
      + (turn.toolCalls.map((call) => `${call.name}.${String(call.args.action ?? '?')}`).join(', ')
        || 'nothing'))
      .toBeDefined();
    const where = storedMemoryFact(db, await rt.memory.read('memory/MEMORY.md'));
    expect(where, 'the memory tool reported a write but neither memory/MEMORY.md nor agent_facts '
      + 'holds the fact, so nothing was persisted for step 6 to find')
      .not.toBeNull();
    console.log(`  Stored via memory.${String(wrote?.args.action)} in ${String(where)}`);
  }, 120_000);

  // ── Step 6: Close and reopen with openWorkspaceCLI ──────────────────

  liveTest('6. close and reopen agent — verify persistence', async () => {
    db.close();

    const db2 = new Database(DB_PATH);
    const { rt: rt2, info } = await openWorkspaceCLI(db2, DB_PATH, { llm: LLM_CONFIG, hostRoot: null });
    // Handed over BEFORE the assertions below, not after them. `db` is already
    // closed, so a failing assertion used to leave every later step holding a
    // dead handle: step 7 reported `bun:sqlite` prepare errors that had nothing
    // to do with what it asserts, and the run showed three failures for one
    // cause.
    db = db2;
    rt = rt2;

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
    expect(storedMemoryFact(db2, await rt2.memory.read('memory/MEMORY.md')),
      'the memory note did not survive the close and reopen — neither memory/MEMORY.md nor '
      + 'agent_facts holds it in the reopened workspace')
      .not.toBeNull();

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

    // The schema step 1 named, over the REOPENED store: this is the
    // persistence claim, not a second copy of step 1. A bare `length > 0`
    // stood here and passed over any store that opened at all.
    for (const table of [
      'workspace_identity', 'messages', 'inodes', 'search_nodes',
      'scaffold_versions', 'crafted_tools', 'fibers',
    ]) {
      expect(tables).toContain(table);
    }
  });
});
