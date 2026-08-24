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
  initWorkspaceSchema,
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
import { openWorkspaceCLI } from '../packages/cli-backend/src/open';
import { makeWorkspaceSchemaSql, type CLIRuntime } from '../packages/cli-backend/src/runtime';
import { buildEvalAgentSurface, requireSandboxedExecutors } from './evals/harness';
import {
  finalIntegerAnswer,
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend, UNCONFIGURED_LLM,
} from '@kinu.run/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('Deep Evolution');
const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'kinu-deep-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

interface Problem {
  id: number;
  question: string;
  /** One integer, because every question below ends "ONLY the number" and the
   *  scorer compares numerically. */
  answer: number;
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
  let rt: CLIRuntime;
  let tools: ToolSet;
  let engine: EvolutionEngine;
  let events: EvolutionEvent[];
  let model: LanguageModel;

  const scorecard: Array<{
    id: number; difficulty: string; correct: boolean; answered: number | null;
    usedExecuteCode: boolean; toolNames: string[]; responsePreview: string;
  }> = [];

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');

    // BIRTH, then the WHOLE schema, then OPEN. This suite's purpose tells the
    // model "Always use execute_tools to compute answers", and on the birth
    // runtime that tool is not configured — measured live, the model called it,
    // got "not configured", fell back to `run`, and the scorecard still printed
    // "used execute_tools" because it counts the NAME. `openWorkspaceCLI` builds
    // the runtime that actually carries the tool.
    await createWorkspace(db, {
      name: 'algo-solver',
      purpose: 'An algorithmic problem solver. Always use execute_tools to compute answers. Never guess.',
      llm: LLM_CONFIG,
    });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    ({ rt } = await openWorkspaceCLI(db, DB_PATH, { llm: LLM_CONFIG, hostRoot: null }));
    requireSandboxedExecutors('deep-evolution', rt);

    events = [];
    engine = new EvolutionEngine(rt, { enabled: true });
    engine.onEvent(e => events.push(e));

    // The model is resolved BEFORE the surface, because the production actor
    // root needs one: `agents` is built from deps that carry the model a search
    // expands with, so a surface built first would be the product's minus its
    // delegation tool.
    model = liveChatModel(LLM_CONFIG);
    tools = buildEvalAgentSurface({ rt, model, llm: LLM_CONFIG }).tools;
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

      // THE ORACLE. `response.includes(String(problem.answer))` stood here and it
      // was not one: four of these eight answers are single digits and two of
      // those digits are in their own QUESTION, so a response that echoed the
      // prompt scored CORRECT. Measured on the questions themselves, an echo
      // passed problems 8, 3 and 4. `finalIntegerAnswer` states the extraction
      // rule and the credential-free test below guards it.
      const answered = finalIntegerAnswer(response);
      const correct = answered === problem.answer;
      const usedExecuteCode = toolNames.includes('execute_tools');

      scorecard.push({
        id: problem.id, difficulty: problem.difficulty, correct, answered, usedExecuteCode,
        toolNames, responsePreview: response.slice(0, 100),
      });

      console.log(`  A: ${response.slice(0, 120)}${response.length > 120 ? '...' : ''}`);
      console.log(`  Tools: ${toolNames.length > 0 ? toolNames.join(', ') : 'none'}`);
      console.log(`  Answered: ${answered === null ? 'nothing extractable' : String(answered)}`);
      console.log(`  Expected: ${problem.answer}`);
      console.log(`  ${correct ? '✅ CORRECT' : '❌ WRONG'} ${usedExecuteCode ? '(used execute_tools)' : '(no code execution)'}`);
    }

    const correctCount = scorecard.filter(s => s.correct).length;
    console.log(`\n  Correct: ${correctCount}/${PROBLEMS.length}`);
    // ONE is a floor on "an answer was really computed", and only now is it that.
    // Under the substring scorer this line asserted nothing: four of the eight
    // answers were reachable by echoing the question, so a model that solved
    // none of them still passed. An extracted integer cannot come from an echo,
    // so the same number is now a claim.
    //
    // Left at one rather than raised to a fraction of eight. The scorecard is
    // the measurement — eight problems, printed per problem with what each
    // answered — and this is the liveness floor under it. Eight problems
    // attempted once each, on whichever tier the run pins, is too small a sample
    // to carry a higher bar, and a provider failure already reds this suite
    // through `solveProblem`'s throw rather than through a low count. Raising it
    // would trade a real floor for a flake on a model wobble.
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
      const said = s.answered === null ? 'none' : String(s.answered);
      console.log(`  ${mark} ${code} #${s.id} [${s.difficulty.padEnd(6)}] said=${said} `
        + `tools=[${s.toolNames.join(',')}]`);
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

/**
 * The oracle itself, guarded — credential-free, so a run with no model still
 * verifies the instrument.
 *
 * Every case is a shape a live response takes. The first test is the RED one:
 * the question echoed back. The substring scorer this replaced returned true
 * for three of the eight problems on that input, so a model that answered
 * nothing scored correct and the suite's floor of one was satisfied for free.
 */
describe('the answer oracle these problems are scored with', () => {
  test('an echoed question answers nothing, on every problem whose answer it contains', () => {
    // Derived from the corpus rather than listed: the hazard IS "the question
    // states the answer", so the cases are exactly the problems where it does.
    const echoing = PROBLEMS.filter(p => p.question.includes(String(p.answer)));
    expect(echoing.map(p => p.id)).toEqual([3, 4, 8]);
    for (const p of echoing) {
      expect(finalIntegerAnswer(p.question)).not.toBe(p.answer);
    }
  });

  test('a digit inside a larger token is not an answer', () => {
    // `4x4 grid` is problem 8's own opening and the reason its answer of 4 was
    // free. A digit welded to a letter is part of a word.
    expect(finalIntegerAnswer('4x4 grid')).toBeNull();
    expect(finalIntegerAnswer('run_2 finished')).toBeNull();
    // A digit inside a longer NUMBER is not the number either, which is the
    // `42` matches `1042` half of the same defect.
    expect(finalIntegerAnswer('1042')).toBe(1042);
  });

  test('the answer the response stood behind is the one extracted', () => {
    expect(finalIntegerAnswer('1060')).toBe(1060);
    expect(finalIntegerAnswer('1060.')).toBe(1060);
    expect(finalIntegerAnswer('The answer is 1060')).toBe(1060);
    expect(finalIntegerAnswer('1,060')).toBe(1060);
    // Working first, answer last — including the prompt's own numbers.
    expect(finalIntegerAnswer('Primes below 100, summed: 1060')).toBe(1060);
    expect(finalIntegerAnswer('```js\nlet total = 0;\n```\n1060')).toBe(1060);
    // The converse shape: answer stated, then the code that produced it. The
    // fence is dropped, so the 100 inside it is not the answer.
    expect(finalIntegerAnswer('1060\n```js\nfor (let n = 2; n < 100; n++) {}\n```')).toBe(1060);
    // A fence holding the answer and nothing outside it still answers.
    expect(finalIntegerAnswer('```\n1060\n```')).toBe(1060);
  });

  test('a response with no integer answered nothing', () => {
    expect(finalIntegerAnswer('')).toBeNull();
    expect(finalIntegerAnswer('I could not compute this.')).toBeNull();
    // A fraction is not an integer answer, so neither half of it is extracted.
    expect(finalIntegerAnswer('about 1.5')).toBeNull();
  });

  test('a negative is not its positive', () => {
    expect(finalIntegerAnswer('-4')).toBe(-4);
    // Over the whole corpus rather than one problem: no answer here is negative,
    // so a response stating the negation of one has not stated it.
    for (const p of PROBLEMS) {
      expect(finalIntegerAnswer(`-${String(p.answer)}`)).not.toBe(p.answer);
    }
    // A hyphen between digits is a range, so `0-3` states 0 and no negative.
    expect(finalIntegerAnswer('grid rows 0-3')).toBe(0);
  });
});
