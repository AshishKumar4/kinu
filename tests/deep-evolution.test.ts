/**
 * Deep Evolution Test — 8 algorithmic challenges with verifiable answers.
 *
 * Uses native AI SDK generateText({ tools, stopWhen }) — no hand-rolled parsing.
 * The agent must write and execute code to solve each problem.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateText, stepCountIs, type LanguageModel, type ToolSet, type StepResult } from 'ai';
import * as v from 'valibot';

import {
  EvolutionEngine,
  buildBuiltinTools,
  initSearchTables,
  initScaffoldTables,
  initCraftScoreTables,
  readSoul,
  JsonObjectSchema,
  projectJsonValue,
  type AgentRuntime,
  type LLMProviderConfig,
  type CompletedTurn,
  type EvolutionEvent,
  type ToolCallRecord,
} from '../packages/core/src/index';
import { createWorkspace } from '../packages/core/src/identity/index';
import {
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend, UNCONFIGURED_LLM,
} from '@proteus/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('Deep Evolution');
const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'proteus-deep-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

interface Problem {
  id: number;
  question: string;
  answer: number | string;
  difficulty: 'easy' | 'medium' | 'hard';
}

const PROBLEMS: Problem[] = [
  { id: 1, question: 'What is the sum of all prime numbers below 100? Use the execute_tools tool to compute it. Return ONLY the number.', answer: 1060, difficulty: 'easy' },
  { id: 2, question: 'How many structurally unique BSTs with 7 nodes? (7th Catalan number.) Use execute_tools. Return ONLY the number.', answer: 429, difficulty: 'easy' },
  { id: 3, question: 'Length of longest strictly increasing subsequence of [3,1,4,1,5,9,2,6,5,3,5,8,9,7,9]? Use execute_tools. ONLY the number.', answer: 6, difficulty: 'medium' },
  { id: 4, question: 'Min coins (denominations 1,5,10,25) for 97 cents? Use execute_tools. ONLY the number.', answer: 7, difficulty: 'medium' },
  { id: 5, question: 'How many ways to partition 30 into distinct positive integers? Use execute_tools. ONLY the number.', answer: 296, difficulty: 'medium' },
  { id: 6, question: 'Chromatic number of the Petersen graph? ONLY the number.', answer: 3, difficulty: 'hard' },
  { id: 7, question: 'Fibonacci(20) mod 997? (F(1)=1,F(2)=1,F(3)=2,...) Use execute_tools. ONLY the number.', answer: 783, difficulty: 'medium' },
  { id: 8, question: '4x4 grid (0-3), paths from (0,0) to (3,3), right/down only, cells (1,1) and (2,2) blocked. How many? Use execute_tools. ONLY the number.', answer: 4, difficulty: 'hard' },
];

/** Run one problem using native AI SDK tool calling */
async function solveProblem(
  model: LanguageModel,
  rt: AgentRuntime,
  tools: ToolSet,
  problem: Problem,
): Promise<{ response: string; turn: CompletedTurn; toolNames: string[] }> {
  const start = Date.now();
  const soul = await readSoul(rt.storage.vfs) ?? '';
  const knowledge = (await rt.memory.read('memory/MEMORY.md'))?.slice(0, 1500) ?? '';

  const toolNames: string[] = [];
  const toolCallRecords: ToolCallRecord[] = [];
  let stepCount = 0;

  const result = await generateText({
    model,
    system: `${soul}\n\nKnowledge:\n${knowledge}\n\nAlways use execute_tools to compute and verify answers. Never guess.`,
    messages: [{ role: 'user' as const, content: problem.question }],
    tools,
    stopWhen: stepCountIs(500),
    onStepFinish: (step: StepResult<ToolSet>) => {
      stepCount++;
      if (step.toolCalls) {
        for (const tc of step.toolCalls) {
          toolNames.push(tc.toolName);
          toolCallRecords.push({
            name: tc.toolName,
            args: v.parse(JsonObjectSchema, tc.input),
            result: null,
          });
        }
      }
      if (step.toolResults) {
        for (let i = 0; i < step.toolResults.length; i++) {
          const idx = toolCallRecords.length - step.toolResults.length + i;
          const record = toolCallRecords[idx];
          const toolResult = step.toolResults[i];
          if (record && toolResult) record.result = projectJsonValue({ value: toolResult.output });
        }
      }
    },
  });

  recordLiveModelSpend(result.usage);

  const response = result.text.trim();

  // Store in DB
  const id = crypto.randomUUID();
  void rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${id}, ${'deep'}, ${'user'}, ${problem.question})`;
  void rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${'deep'}, ${id}, ${'assistant'}, ${response})`;

  const turn: CompletedTurn = {
    userMessage: problem.question,
    assistantResponse: response,
    toolCalls: toolCallRecords,
    steps: stepCount,
    durationMs: Date.now() - start,
    feedback: null,
    hadError: false,
  };

  return { response, turn, toolNames };
}

describe('Deep Evolution — 8 Algorithmic Challenges', () => {
  let db: InstanceType<typeof Database>;
  let rt: AgentRuntime;
  let tools: ToolSet;
  let engine: EvolutionEngine;
  let events: EvolutionEvent[];
  let model: LanguageModel;

  const scorecard: Array<{
    id: number; difficulty: string; correct: boolean;
    usedExecuteCode: boolean; toolNames: string[]; responsePreview: string;
  }> = [];

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');

    rt = await createWorkspace(db, {
      name: 'algo-solver',
      purpose: 'An algorithmic problem solver. Always use execute_tools to compute answers. Never guess.',
      llm: LLM_CONFIG,
    });
    initSearchTables(rt.storage.execRaw, rt.storage.sql);
    initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
    initCraftScoreTables(rt.storage.execRaw);

    events = [];
    engine = new EvolutionEngine(rt, { enabled: true });
    tools = buildBuiltinTools({ rt });
    engine.onEvent(e => events.push(e));

    model = liveChatModel(LLM_CONFIG);
  });

  afterAll(() => {
    reportLiveModelSpend('Deep Evolution');
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  liveTest('solve 8 algorithmic problems with native tool calling', async () => {
    for (const problem of PROBLEMS) {
      console.log(`\n  ── Problem ${problem.id} [${problem.difficulty}] ──`);
      console.log(`  Q: ${problem.question.slice(0, 80)}...`);

      const { response, turn, toolNames } = await solveProblem(model, rt, tools, problem);
      await engine.reviewTurn(turn, null);

      const correct = response.includes(String(problem.answer));
      const usedExecuteCode = toolNames.includes('execute_tools');

      scorecard.push({
        id: problem.id, difficulty: problem.difficulty, correct, usedExecuteCode,
        toolNames, responsePreview: response.slice(0, 100),
      });

      console.log(`  A: ${response.slice(0, 120)}${response.length > 120 ? '...' : ''}`);
      console.log(`  Tools: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}`);
      console.log(`  Expected: ${problem.answer}`);
      console.log(`  ${correct ? '✅ CORRECT' : '❌ WRONG'} ${usedExecuteCode ? '(used execute_tools)' : '(no code execution)'}`);
    }

    const correctCount = scorecard.filter(s => s.correct).length;
    console.log(`\n  Correct: ${correctCount}/${PROBLEMS.length}`);
    expect(correctCount).toBeGreaterThanOrEqual(1);
  }, 1800_000);

  liveTest('scorecard and evolution summary', () => {
    console.log('\n  ══════════════════════════════════════════════');
    console.log('  SCORECARD');
    console.log('  ══════════════════════════════════════════════');

    let correct = 0, usedCode = 0;
    for (const s of scorecard) {
      const mark = s.correct ? '✅' : '❌';
      const code = s.usedExecuteCode ? '💻' : '  ';
      console.log(`  ${mark} ${code} #${s.id} [${s.difficulty.padEnd(6)}] tools=[${s.toolNames.join(',')}]`);
      if (s.correct) correct++;
      if (s.usedExecuteCode) usedCode++;
    }

    console.log(`\n  Results: ${correct} correct, ${PROBLEMS.length - correct} wrong out of ${PROBLEMS.length}`);
    console.log(`  Used execute_tools: ${usedCode}/${PROBLEMS.length}`);
    console.log(`\n  Evolution events: ${events.length}`);
    const byType: Record<string, number> = {};
    for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
    for (const [type, count] of Object.entries(byType)) console.log(`    ${type}: ${count}`);

    const craftedTools = rt.craftStore.list();
    console.log(`\n  Crafted tools: ${craftedTools.length}`);
    for (const t of craftedTools) console.log(`    ${t.name}: ${t.description.slice(0, 60)}`);

    console.log('  ══════════════════════════════════════════════');
    expect(scorecard.length).toBe(PROBLEMS.length);
  });
});
