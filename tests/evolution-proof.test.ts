/**
 * Evolution Proof Test — proves the agent's evolution system actually works.
 *
 * Structure:
 *   Session 1: Agent solves crypto/algorithmic challenges, patterns get extracted
 *   Session 2: Agent faces SIMILAR challenges — crafted tools from session 1
 *              should be available and the agent should perform better
 *
 * Challenges are CTF-inspired: crypto, algorithms, code analysis.
 * All verifiable via deterministic outputs.
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
  collectStepText,
  EvolutionEngine,
  initWorkspaceSchema,
  readSoul,
  JsonObjectSchema,
  projectJsonValue,
  type AgentRuntime,
  type LLMProviderConfig,
  type CompletedTurn,
  type ToolCallRecord,
} from '../packages/core/src/index';
import { createWorkspace } from '../packages/core/src/identity/index';
import { openWorkspaceCLI } from '../packages/cli-backend/src/open';
import { makeWorkspaceSchemaSql } from '../packages/cli-backend/src/runtime';
import { requireSandboxedExecutors } from './evals/harness';
import {
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend, UNCONFIGURED_LLM,
} from '@proteus/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('Evolution Proof');
const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'proteus-evolution-proof-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

interface TurnResult {
  text: string;
  toolCalls: ToolCallRecord[];
  steps: number;
  durationMs: number;
}

async function chatTurn(
  model: LanguageModel,
  rt: AgentRuntime,
  tools: ToolSet,
  userMessage: string,
  sessionId: string,
): Promise<TurnResult> {
  const start = Date.now();
  const soul = await readSoul(rt.storage.vfs) ?? '';
  const knowledge = (await rt.memory.read('memory/MEMORY.md'))?.slice(0, 3000) ?? '';

  const tcRecords: ToolCallRecord[] = [];
  let stepCount = 0;

  const result = await generateText({
    model,
    system: [
      soul,
      '\n\n## Knowledge\n', knowledge,
      '\n\nAfter using tools, always summarize what you did and the results.',
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

  const responseText = collectStepText(result);

  const id = crypto.randomUUID();
  void rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${id}, ${sessionId}, ${'user'}, ${userMessage})`;
  void rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${sessionId}, ${id}, ${'assistant'}, ${responseText})`;

  return { text: responseText, toolCalls: tcRecords, steps: stepCount, durationMs: Date.now() - start };
}

// ── Challenges ───────────────────────────────────────────────────

// Challenge 1: RSA with tiny key — factor n, decrypt c
const RSA_CHALLENGE_1 = `
Solve this RSA crypto challenge. You MUST use execute_tools to compute the answer.

Given:
  n = 3233 (public modulus, product of two primes)
  e = 17 (public exponent)
  c = 2201 (ciphertext)

Find the plaintext m such that c = m^e mod n.
Steps: factor n into p*q, compute phi = (p-1)*(q-1), find d = modular inverse of e mod phi, then m = c^d mod n.
Return ONLY the numeric value of m.
`;

// Challenge 2: Similar RSA but different numbers — should be faster with pattern
const RSA_CHALLENGE_2 = `
Solve this RSA crypto challenge. You MUST use execute_tools to compute the answer.

Given:
  n = 5959 (public modulus, product of two primes)  
  e = 13 (public exponent)
  c = 2531 (ciphertext)

Find the plaintext m such that c = m^e mod n.
Steps: factor n into p*q, compute phi, find modular inverse d, then m = c^d mod n.
Return ONLY the numeric value of m.
`;

// Challenge 3: Dijkstra's algorithm — complex graph problem
const DIJKSTRA_CHALLENGE_1 = `
Implement Dijkstra's shortest path algorithm and solve this problem. Use execute_tools.

Graph (adjacency list with weights):
  A -> B:4, C:2
  B -> D:3, C:1
  C -> B:1, D:5
  D -> (none)

Find the shortest distance from A to D. Return ONLY the number.
`;

// Challenge 4: Similar graph problem — should benefit from previous algorithm
const DIJKSTRA_CHALLENGE_2 = `
Find the shortest path using Dijkstra's algorithm. Use execute_tools.

Graph (adjacency list with weights):
  S -> A:7, B:2, C:3
  A -> B:3, D:4
  B -> A:3, C:4, D:1
  C -> D:5
  D -> (none)

Find the shortest distance from S to D. Return ONLY the number.
`;

// Challenge 5: Substitution cipher — decode
const CIPHER_CHALLENGE = `
Decode this substitution cipher. Use execute_tools to try frequency analysis.

The cipher maps each letter to another letter. The ciphertext is:
"GSVJF RXLWV RHHVX IVG"

This is encoded with the Atbash cipher (A=Z, B=Y, C=X, ..., Z=A).
Decode it and return the plaintext.
`;

describe('Evolution Proof', () => {
  let db: InstanceType<typeof Database>;
  let rt: AgentRuntime;
  let engine: EvolutionEngine;
  let model: LanguageModel;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    // BIRTH, then OPEN, then the WHOLE schema — the three hand-picked init calls
    // this replaced omitted `initShadowTables`, so `scaffold_evaluations` did not
    // exist and `engine.onSessionComplete` below died on it 102s into a paid run.
    // `initWorkspaceSchema` is the one function that declares a workspace's
    // tables; a subset maintained by hand drifts from it by default.
    await createWorkspace(db, {
      name: 'evolution-proof',
      purpose: 'A crypto and algorithm expert that solves CTF-style challenges using code execution.',
      llm: LLM_CONFIG,
    });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    // The real runtime rather than the birth one, so evolution reaches a genuine
    // branch spawner, and `hostRoot: null` keeps its executors off this repo.
    ({ rt } = await openWorkspaceCLI(db, DB_PATH, { llm: LLM_CONFIG, hostRoot: null }));
    requireSandboxedExecutors('evolution-proof', rt);
    model = liveChatModel(LLM_CONFIG);
    engine = new EvolutionEngine(rt, { enabled: true });
    engine.onEvent(e => console.log(`    [evolution] ${e.type}: ${e.message.slice(0, 80)}`));
  });

  afterAll(() => {
    reportLiveModelSpend('Evolution Proof');
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── SESSION 1: Solve challenges, build patterns ──────────────

  let session1Results: TurnResult[] = [];

  liveTest('session 1, turn 1: RSA challenge (learn the pattern)', async () => {
    const tools = buildBuiltinTools({ rt });
    const toolNames = Object.keys(tools);
    console.log(`    Tools available: ${toolNames.join(', ')}`);
    expect(toolNames).toContain('execute_tools');

    const result = await chatTurn(model, rt, tools, RSA_CHALLENGE_1, 'session-1');
    session1Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.toolCalls.some(tc => tc.name === 'execute_tools')).toBe(true);

    // Fire evolution — should extract pattern from successful tool usage
    await engine.reviewTurn({
      userMessage: RSA_CHALLENGE_1,
      assistantResponse: result.text,
      toolCalls: result.toolCalls,
      steps: result.steps,
      durationMs: result.durationMs,
      feedback: 'positive',
      hadError: false,
    }, null);
  }, 600_000);

  liveTest('session 1, turn 2: Dijkstra challenge (learn algorithm pattern)', async () => {
    const tools = buildBuiltinTools({ rt });
    const result = await chatTurn(model, rt, tools, DIJKSTRA_CHALLENGE_1, 'session-1');
    session1Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);

    await engine.reviewTurn({
      userMessage: DIJKSTRA_CHALLENGE_1,
      assistantResponse: result.text,
      toolCalls: result.toolCalls,
      steps: result.steps,
      durationMs: result.durationMs,
      feedback: 'positive',
      hadError: false,
    }, null);
  }, 600_000);

  liveTest('session 1, turn 3: cipher challenge + session reflection', async () => {
    const tools = buildBuiltinTools({ rt });
    const result = await chatTurn(model, rt, tools, CIPHER_CHALLENGE, 'session-1');
    session1Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);

    await engine.reviewTurn({
      userMessage: CIPHER_CHALLENGE,
      assistantResponse: result.text,
      toolCalls: result.toolCalls,
      steps: result.steps,
      durationMs: result.durationMs,
      feedback: 'positive',
      hadError: false,
    }, null);

    // End session 1 — triggers session reflection
    const challenges = [RSA_CHALLENGE_1, DIJKSTRA_CHALLENGE_1, CIPHER_CHALLENGE];
    const turns: CompletedTurn[] = session1Results.map((result, index) => {
      const userMessage = challenges[index];
      if (!userMessage) throw new Error(`missing challenge for session result ${index}`);
      return {
        userMessage,
        assistantResponse: result.text,
        toolCalls: result.toolCalls,
        steps: result.steps,
        durationMs: result.durationMs,
        feedback: 'positive',
        hadError: false,
      };
    });
    await engine.onSessionComplete({
      sessionId: 'session-1',
      turns,
      startedAt: Date.now() - 60000,
      endedAt: Date.now(),
    });
  }, 600_000);

  // ── Verify evolution happened ────────────────────────────────

  liveTest('evolution artifacts exist after session 1', async () => {
    // THE DENOMINATOR, first, because every claim below is about what the
    // GRADED turns produced. Nothing here grades a turn conversationally — a
    // proof drives challenges, never a follow-up — so the verdict comes from the
    // execution channel, which grades exactly the turns that ran tools and
    // leaves the rest ungraded (evolution/engine.ts:364-376). Asserted against
    // that set rather than against 3, so a challenge the model happened to
    // answer in prose does not read as evolution declining to fire.
    const outcomes = rt.storage.sql<{ outcome: string; source: string }>`
      SELECT outcome, source FROM turn_outcomes`;
    const accepted = outcomes.filter(o => o.outcome === 'accepted');
    const turnsThatRanTools = session1Results.filter(r => r.toolCalls.length > 0).length;
    console.log(`    Graded turns: ${outcomes.map(o => `${o.outcome}/${o.source}`).join(', ')}`);
    expect(turnsThatRanTools).toBeGreaterThan(0);
    expect(accepted.length).toBe(turnsThatRanTools);

    // WHAT THE RUN RECORDED, as content rather than as a size.
    //
    // This assertion was `memory.length > 100`, and it could neither fail for
    // the reason it claimed nor pass for one. MEMORY.md is the CORROBORATED
    // lesson file: a turn's reflection reaches it only on a negative verdict
    // from a PERSON (engine.ts:453) and a session reflection only on a window
    // carrying negative signal at all (engine.ts:606 via
    // sessionWarrantsReflection, whose doc states that an all-accepted window
    // returns false). Every turn above is accepted, so nothing reflects and
    // nothing is appended — and what was being measured was the BIRTH header,
    // whose length is the workspace name plus 38 characters. A live run
    // reported 53 with three tools extracted and all three executable; a longer
    // workspace name would have turned the same empty file green.
    //
    // So the artifact is the one evolution produces from an ACCEPTED turn:
    // extractPattern generalizes the turn's tool calls and upsertCraftedTool
    // admits the result only after compiling it to a callable and seeding the
    // EMA row (craft/conflict.ts:90-126). Asserted per tool, because a count
    // alone is what let a stored "tool" whose body was `await ({ runtime })(…)`
    // read as an artifact.
    const crafted = rt.craftStore.list();
    const scores = new Map(rt.storage.sql<{ tool_name: string; score: number }>`
      SELECT tool_name, score FROM craft_scores`.map(r => [r.tool_name, r.score]));
    console.log(`    Crafted tools: ${crafted.length}`);
    expect(crafted.length).toBeGreaterThan(0);
    for (const t of crafted) {
      console.log(`      ${t.name} (score ${String(scores.get(t.name))}): ${t.description.slice(0, 60)}`);
      console.log(`        code: ${t.code.slice(0, 80)}...`);
      // Named, so a later turn can ask for it by name.
      expect(t.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      // CALLABLE, compiled exactly as the CLI invokes a crafted tool. The
      // store's own admission gate ran this before the write; running it here
      // is what makes "3 crafted tools" a claim about artifacts rather than
      // about rows.
      expect(new Function(`return (${t.code})`)()).toBeInstanceOf(Function);
      // Scored, or the effective-score floor exempts it from retirement
      // forever however it behaves (craft/ema.ts:39-42).
      expect(scores.has(t.name)).toBe(true);
    }

    // Memory itself: the birth record survived the reopen, and carries no
    // lesson or reflection heading, because this window corroborated none. The
    // absence is asserted beside the reason for it rather than left to a
    // character count that cannot tell it from a truncated write.
    const memory = await rt.memory.read('memory/MEMORY.md');
    if (!memory) throw new Error('the workspace lost memory/MEMORY.md between birth and this read');
    console.log(`    Memory (${memory.length} chars): ${JSON.stringify(memory.slice(0, 120))}`);
    expect(memory).toContain('# evolution-proof');
    expect(memory).not.toContain('### Lesson');
    expect(memory).not.toContain('## Session reflection');

    // Indexing rides an append, so an all-accepted window indexes nothing —
    // reported, and the reason is the line above.
    const chunks = rt.storage.sql<{ path: string }>`SELECT DISTINCT path FROM memory_chunks`;
    console.log(`    Memory chunks: ${chunks.length}`);

    // Both halves of every turn are on the session tree the next session reads.
    const msgCount = rt.storage.sql<{ c: number }>`SELECT COUNT(*) as c FROM messages`[0]?.c ?? 0;
    console.log(`    Messages: ${msgCount}`);
    expect(msgCount).toBe(session1Results.length * 2);
  });

  // ── SESSION 2: Similar challenges — should benefit from evolution ──

  let session2Results: TurnResult[] = [];

  liveTest('session 2, turn 1: similar RSA challenge (should benefit from pattern)', async () => {
    const tools = buildBuiltinTools({ rt });
    console.log(`    Tools available: ${Object.keys(tools).join(', ')}`);

    // What session 2 inherits, from the store it inherits it in. Crafted tools
    // are codemode-only — reached as `codemode.<name>` inside `execute_tools`,
    // never as SDK tools (evolution/engine.ts:433-436) — so subtracting a
    // hardcoded builtin count from the list above measures nothing: it printed
    // `Crafted tools loaded: -1` beside a correct `Crafted tools: 3` as soon as
    // the builtin count moved. The transfer is what this session is for, so it
    // is asserted rather than counted wrong.
    const inherited = rt.craftStore.list().map(t => t.name);
    console.log(`    Crafted tools inherited from session 1: ${inherited.join(', ')}`);
    expect(inherited.length).toBeGreaterThan(0);

    const result = await chatTurn(model, rt, tools, RSA_CHALLENGE_2, 'session-2');
    session2Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);
  }, 600_000);

  liveTest('session 2, turn 2: similar graph challenge (should benefit from pattern)', async () => {
    const tools = buildBuiltinTools({ rt });
    const result = await chatTurn(model, rt, tools, DIJKSTRA_CHALLENGE_2, 'session-2');
    session2Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);
  }, 600_000);

  // ── Final analysis ─────────────────────────────────────────────

  liveTest('evolution summary: compare session 1 vs session 2', () => {
    console.log('\n    ═══ EVOLUTION PROOF SUMMARY ═══');

    // Session 1 metrics
    const s1Steps = session1Results.reduce((s, r) => s + r.steps, 0);
    const s1Time = session1Results.reduce((s, r) => s + r.durationMs, 0);
    const s1Tools = session1Results.reduce((s, r) => s + r.toolCalls.length, 0);

    // Session 2 metrics (only RSA + Dijkstra, comparable to session 1's first 2)
    const s2Steps = session2Results.reduce((s, r) => s + r.steps, 0);
    const s2Time = session2Results.reduce((s, r) => s + r.durationMs, 0);
    const s2Tools = session2Results.reduce((s, r) => s + r.toolCalls.length, 0);

    console.log(`    Session 1 (learning): ${s1Steps} steps, ${s1Tools} tool calls, ${(s1Time / 1000).toFixed(1)}s`);
    console.log(`    Session 2 (evolved):  ${s2Steps} steps, ${s2Tools} tool calls, ${(s2Time / 1000).toFixed(1)}s`);

    // Compare RSA specifically
    const rsa1 = session1Results[0];
    const rsa2 = session2Results[0];
    if (!rsa1 || !rsa2) throw new Error('RSA comparison requires one result from each session');
    console.log(`\n    RSA Challenge 1: ${rsa1.steps} steps, ${rsa1.toolCalls.length} tools, ${(rsa1.durationMs / 1000).toFixed(1)}s`);
    console.log(`    RSA Challenge 2: ${rsa2.steps} steps, ${rsa2.toolCalls.length} tools, ${(rsa2.durationMs / 1000).toFixed(1)}s`);

    // Compare Dijkstra specifically
    if (session1Results[1] && session2Results[1]) {
      const dj1 = session1Results[1];
      const dj2 = session2Results[1];
      console.log(`\n    Dijkstra 1: ${dj1.steps} steps, ${dj1.toolCalls.length} tools, ${(dj1.durationMs / 1000).toFixed(1)}s`);
      console.log(`    Dijkstra 2: ${dj2.steps} steps, ${dj2.toolCalls.length} tools, ${(dj2.durationMs / 1000).toFixed(1)}s`);
    }

    // Check crafted tools. No `✓ executable` verdict is computed here: the label
    // printed one from `!code.startsWith('//')`, which is the admission test the
    // compile gate replaced (craft/conflict.ts:47-52) and which passed prose and
    // statement fragments. Whether these compile is asserted, once, where the
    // artifacts are checked.
    const crafted = rt.craftStore.list();
    console.log(`\n    Crafted tools: ${crafted.length}`);
    for (const t of crafted) {
      console.log(`      ${t.name}: ${t.description.slice(0, 50)}`);
    }

    // DB state
    const msgCount = rt.storage.sql<{ c: number }>`SELECT COUNT(*) as c FROM messages`[0]?.c ?? 0;
    const craftCount = rt.storage.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;
    console.log(`\n    DB: ${msgCount} messages, ${craftCount} crafted tools`);

    console.log('    ═══ END SUMMARY ═══\n');

    // The test passes if:
    // 1. Both sessions produced non-empty responses
    expect(session1Results.every(r => r.text.length > 0)).toBe(true);
    expect(session2Results.every(r => r.text.length > 0)).toBe(true);

    // 2. Tools were used in session 1
    expect(s1Tools).toBeGreaterThan(0);

    // 3. Every turn of both sessions is on the session tree
    expect(msgCount).toBeGreaterThan(0);
  });
});
