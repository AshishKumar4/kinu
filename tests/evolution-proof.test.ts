/**
 * Evolution Proof Test — proves the agent's evolution system actually works.
 *
 * Structure:
 *   Session 1: Agent solves crypto/algorithmic challenges, patterns get extracted
 *   Session 2: Agent faces SIMILAR challenges — crafted tools from session 1
 *              should be available and the agent should perform better
 *
 * Challenges are CTF-inspired: crypto, algorithms, ciphers. Each one is DATA,
 * its prompt is rendered from that data, and its correct answer is computed from
 * the same data by a solver in this file — so a turn's answer is checked, and
 * the solvers themselves are checked by a credential-free test at the bottom.
 * The claim that stood here, "all verifiable via deterministic outputs", was
 * true of the challenges and false of the test: not one of its assertions
 * compared an answer, and the correct answers were written down nowhere.
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
  finalIntegerAnswer, letterKey,
  liveChatModel, liveModelTarget, recordLiveModelSpend, reportLiveModelSpend, UNCONFIGURED_LLM,
} from '@kinu.run/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('Evolution Proof');
const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'kinu-evolution-proof-' + Date.now());
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

// ── Challenges, as DATA ──────────────────────────────────────────
//
// Each challenge is its numbers, the prompt is RENDERED from them, and the
// expected answer is COMPUTED from the same numbers by a solver in this file.
// Nothing here is transcribed. Before this, the challenges were prose strings,
// the correct answers appeared nowhere in the file, and none of the suite's 22
// assertions compared the model's answer to anything — so "all verifiable via
// deterministic outputs" was a claim about the challenges and not about the
// test. A prompt that states a parameter beside an oracle that hardcodes the
// answer to that parameter is two numbers with two places to disagree.

/** A textbook RSA challenge: a semiprime modulus, a public exponent, a
 *  ciphertext. Small enough that trial division factors it. */
interface RsaChallenge {
  readonly n: number;
  readonly e: number;
  readonly c: number;
}

/** A weighted directed graph and the pair a distance is asked for. The
 *  adjacency list is ordered because the prompt is rendered from it. */
interface GraphChallenge {
  readonly adjacency: readonly {
    readonly node: string;
    readonly out: readonly { readonly to: string; readonly weight: number }[];
  }[];
  readonly from: string;
  readonly to: string;
}

interface CipherChallenge {
  readonly ciphertext: string;
}

const RSA_1: RsaChallenge = { n: 3233, e: 17, c: 2201 };
const RSA_2: RsaChallenge = { n: 5959, e: 13, c: 2531 };

const GRAPH_1: GraphChallenge = {
  adjacency: [
    { node: 'A', out: [{ to: 'B', weight: 4 }, { to: 'C', weight: 2 }] },
    { node: 'B', out: [{ to: 'D', weight: 3 }, { to: 'C', weight: 1 }] },
    { node: 'C', out: [{ to: 'B', weight: 1 }, { to: 'D', weight: 5 }] },
    { node: 'D', out: [] },
  ],
  from: 'A',
  to: 'D',
};

const GRAPH_2: GraphChallenge = {
  adjacency: [
    { node: 'S', out: [{ to: 'A', weight: 7 }, { to: 'B', weight: 2 }, { to: 'C', weight: 3 }] },
    { node: 'A', out: [{ to: 'B', weight: 3 }, { to: 'D', weight: 4 }] },
    { node: 'B', out: [{ to: 'A', weight: 3 }, { to: 'C', weight: 4 }, { to: 'D', weight: 1 }] },
    { node: 'C', out: [{ to: 'D', weight: 5 }] },
    { node: 'D', out: [] },
  ],
  from: 'S',
  to: 'D',
};

const CIPHER: CipherChallenge = { ciphertext: 'GSVJF RXLWV RHHVX IVG' };

// ── Solvers: the ground truth, computed ──────────────────────────

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining % 2n === 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    remaining /= 2n;
  }
  return result;
}

/** The extended Euclidean algorithm, which is also the check: a value with no
 *  inverse leaves a gcd above one, and that is a broken challenge rather than a
 *  zero to return. */
function modInverse(value: bigint, modulus: bigint): bigint {
  let [remainder, next] = [value % modulus, modulus];
  let [coefficient, nextCoefficient] = [1n, 0n];
  while (next !== 0n) {
    const quotient = remainder / next;
    [remainder, next] = [next, remainder - quotient * next];
    [coefficient, nextCoefficient] = [nextCoefficient, coefficient - quotient * nextCoefficient];
  }
  if (remainder !== 1n) {
    throw new Error(`${String(value)} has no inverse mod ${String(modulus)}, so this RSA `
      + 'challenge has no plaintext');
  }
  return ((coefficient % modulus) + modulus) % modulus;
}

function factorSemiprime(n: number): readonly [number, number] {
  for (let candidate = 2; candidate * candidate <= n; candidate++) {
    if (n % candidate === 0) return [candidate, n / candidate];
  }
  throw new Error(`${String(n)} is prime, so it is not a product of two primes`);
}

function rsaPlaintext({ n, e, c }: RsaChallenge): number {
  const [p, q] = factorSemiprime(n);
  const totient = BigInt(p - 1) * BigInt(q - 1);
  const d = modInverse(BigInt(e), totient);
  return Number(modPow(BigInt(c), d, BigInt(n)));
}

/** Dijkstra over a positive-weight graph. Linear scan for the nearest unsettled
 *  node: five nodes need no heap, and a heap here would be code the test cannot
 *  see the correctness of. */
function shortestDistance({ adjacency, from, to }: GraphChallenge): number {
  const out = new Map(adjacency.map(row => [row.node, row.out]));
  const distance = new Map<string, number>([[from, 0]]);
  const settled = new Set<string>();
  for (;;) {
    let nearest: string | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [node, reached] of distance) {
      if (settled.has(node) || reached >= nearestDistance) continue;
      nearest = node;
      nearestDistance = reached;
    }
    if (nearest === null) break;
    settled.add(nearest);
    for (const edge of out.get(nearest) ?? []) {
      if (nearestDistance + edge.weight < (distance.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distance.set(edge.to, nearestDistance + edge.weight);
      }
    }
  }
  const reached = distance.get(to);
  if (reached === undefined) throw new Error(`${to} is unreachable from ${from}`);
  return reached;
}

const LETTER_A = 'A'.charCodeAt(0);
const LETTER_Z = 'Z'.charCodeAt(0);

/** Atbash: A maps to Z, B to Y, and so on. Its own inverse, which is what the
 *  solver test checks it against. */
function atbash(text: string): string {
  return [...text.toUpperCase()].map(character => {
    const code = character.charCodeAt(0);
    if (code < LETTER_A || code > LETTER_Z) return character;
    return String.fromCharCode(LETTER_Z - (code - LETTER_A));
  }).join('');
}

// ── Prompts, rendered from the data above ────────────────────────
//
// One template per family, so the session-1 instance and the session-2 instance
// differ ONLY in their numbers. That is what makes session 2 a transfer test:
// the pattern session 1 extracted is the whole of what carries over.

function rsaPrompt({ n, e, c }: RsaChallenge): string {
  return `
Solve this RSA crypto challenge. You MUST use execute_tools to compute the answer.

Given:
  n = ${String(n)} (public modulus, product of two primes)
  e = ${String(e)} (public exponent)
  c = ${String(c)} (ciphertext)

Find the plaintext m such that c = m^e mod n.
Steps: factor n into p*q, compute phi = (p-1)*(q-1), find d = modular inverse of e mod phi, then m = c^d mod n.
Return ONLY the numeric value of m.
`;
}

function graphPrompt({ adjacency, from, to }: GraphChallenge): string {
  const rows = adjacency.map(row => `  ${row.node} -> ${row.out.length === 0
    ? '(none)'
    : row.out.map(edge => `${edge.to}:${String(edge.weight)}`).join(', ')}`).join('\n');
  return `
Implement Dijkstra's shortest path algorithm and solve this problem. Use execute_tools.

Graph (adjacency list with weights):
${rows}

Find the shortest distance from ${from} to ${to}. Return ONLY the number.
`;
}

function cipherPrompt({ ciphertext }: CipherChallenge): string {
  return `
Decode this substitution cipher. Use execute_tools to try frequency analysis.

The cipher maps each letter to another letter. The ciphertext is:
"${ciphertext}"

This is encoded with the Atbash cipher (A=Z, B=Y, C=X, ..., Z=A).
Decode it and return the plaintext.
`;
}

const RSA_CHALLENGE_1 = rsaPrompt(RSA_1);
const RSA_CHALLENGE_2 = rsaPrompt(RSA_2);
const DIJKSTRA_CHALLENGE_1 = graphPrompt(GRAPH_1);
const DIJKSTRA_CHALLENGE_2 = graphPrompt(GRAPH_2);
const CIPHER_CHALLENGE = cipherPrompt(CIPHER);

const RSA_ANSWER_1 = rsaPlaintext(RSA_1);
const RSA_ANSWER_2 = rsaPlaintext(RSA_2);
const DIJKSTRA_ANSWER_1 = shortestDistance(GRAPH_1);
const DIJKSTRA_ANSWER_2 = shortestDistance(GRAPH_2);
const CIPHER_ANSWER = atbash(CIPHER.ciphertext);

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

    // THE FLAG. Exactly checkable, and computed by this file's own solver from
    // the same numbers the prompt above was rendered from.
    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(RSA_ANSWER_1)}`);
    expect(answered).toBe(RSA_ANSWER_1);

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

    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(DIJKSTRA_ANSWER_1)}`);
    expect(answered).toBe(DIJKSTRA_ANSWER_1);

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

    // A decoded plaintext is compared on its LETTERS: the model keeps or drops
    // the ciphertext's five-letter grouping as it likes, and that is not part of
    // the answer. `toContain` because the model states the plaintext inside a
    // sentence, and the ciphertext cannot satisfy it — Atbash moves every letter
    // in this string.
    console.log(`    Expected plaintext ${JSON.stringify(CIPHER_ANSWER)}`);
    expect(letterKey(result.text)).toContain(letterKey(CIPHER_ANSWER));

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
  let inheritedToolNames: string[] = [];

  liveTest('session 2, turn 1: similar RSA challenge with inherited artifacts', async () => {
    const tools = buildBuiltinTools({ rt });
    console.log(`    Tools available: ${Object.keys(tools).join(', ')}`);

    // What session 2 inherits, from the store it inherits it in. Crafted tools
    // are codemode-only — reached as `codemode.<name>` inside `execute_tools`,
    // never as SDK tools (evolution/engine.ts:433-436) — so subtracting a
    // hardcoded builtin count from the list above measures nothing: it printed
    // `Crafted tools loaded: -1` beside a correct `Crafted tools: 3` as soon as
    // the builtin count moved. The transfer is what this session is for, so it
    // is asserted rather than counted wrong.
    inheritedToolNames = rt.craftStore.list().map(t => t.name);
    console.log(`    Crafted tools inherited from session 1: ${inheritedToolNames.join(', ')}`);
    expect(inheritedToolNames.length).toBeGreaterThan(0);

    const result = await chatTurn(model, rt, tools, RSA_CHALLENGE_2, 'session-2');
    session2Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);

    // The transfer has to be a transfer of something CORRECT. A session-2 turn
    // that reused a crafted tool and answered wrongly is evidence against the
    // pattern, not for it.
    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(RSA_ANSWER_2)}`);
    expect(answered).toBe(RSA_ANSWER_2);
  }, 600_000);

  liveTest('session 2, turn 2: similar graph challenge with inherited artifacts', async () => {
    const tools = buildBuiltinTools({ rt });
    const result = await chatTurn(model, rt, tools, DIJKSTRA_CHALLENGE_2, 'session-2');
    session2Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);

    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(DIJKSTRA_ANSWER_2)}`);
    expect(answered).toBe(DIJKSTRA_ANSWER_2);
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
    console.log(`    Session 2 (with artifacts): ${s2Steps} steps, ${s2Tools} tool calls, ${(s2Time / 1000).toFixed(1)}s`);

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

    expect(session1Results.every(r => r.text.length > 0)).toBe(true);
    expect(session2Results.every(r => r.text.length > 0)).toBe(true);
    expect(s1Tools).toBeGreaterThan(0);
    const reused = session2Results.some((result) => result.toolCalls.some((call) => {
      const args = JSON.stringify(call.args);
      return inheritedToolNames.some((name) => args.includes(name));
    }));
    expect(reused, 'session 2 did not call any crafted tool from session 1').toBe(true);
    expect(msgCount).toBeGreaterThan(0);
  });
});

/**
 * The oracle itself, guarded — credential-free, so a run with no model still
 * verifies the instrument.
 *
 * Every check below derives its truth INDEPENDENTLY of the solver it checks: an
 * RSA plaintext is re-encrypted and must give the ciphertext back, a shortest
 * distance is compared against an exhaustive walk of every simple path, and
 * Atbash is checked against its own inverse. Nothing is compared against a
 * number somebody worked out by hand, which is the failure this file already
 * carried once — a header claiming deterministic verification over a test that
 * verified nothing.
 */
describe('the challenge solvers these turns are graded by', () => {
  /**
   * The cheapest simple path, by exhaustive walk. A second implementation, and
   * a valid oracle for Dijkstra only because every weight is positive — with a
   * negative edge the cheapest walk can revisit a node and beat every simple
   * path. That premise is asserted rather than assumed.
   */
  const cheapestSimplePath = ({ adjacency, from, to }: GraphChallenge): number => {
    const out = new Map(adjacency.map(row => [row.node, row.out]));
    let cheapest = Number.POSITIVE_INFINITY;
    const walk = (node: string, cost: number, visited: ReadonlySet<string>): void => {
      if (node === to) {
        cheapest = Math.min(cheapest, cost);
        return;
      }
      for (const edge of out.get(node) ?? []) {
        if (visited.has(edge.to)) continue;
        walk(edge.to, cost + edge.weight, new Set([...visited, edge.to]));
      }
    };
    walk(from, 0, new Set([from]));
    return cheapest;
  };

  const RSA_CASES: readonly { readonly challenge: RsaChallenge; readonly answer: number }[] = [
    { challenge: RSA_1, answer: RSA_ANSWER_1 },
    { challenge: RSA_2, answer: RSA_ANSWER_2 },
  ];
  const GRAPH_CASES: readonly { readonly challenge: GraphChallenge; readonly answer: number }[] = [
    { challenge: GRAPH_1, answer: DIJKSTRA_ANSWER_1 },
    { challenge: GRAPH_2, answer: DIJKSTRA_ANSWER_2 },
  ];

  test('each RSA answer re-encrypts to the ciphertext it was decrypted from', () => {
    for (const { challenge, answer } of RSA_CASES) {
      const { n, e, c } = challenge;
      console.log(`    RSA n=${String(n)} e=${String(e)} c=${String(c)} -> m=${String(answer)}`);
      // The RSA identity: c = m^e mod n. Satisfying it IS being the plaintext.
      expect(modPow(BigInt(answer), BigInt(e), BigInt(n))).toBe(BigInt(c));
      // A residue mod n, so a solver that returned the exponent or the modulus
      // itself cannot pass by accident.
      expect(answer).toBeGreaterThanOrEqual(0);
      expect(answer).toBeLessThan(n);
      // The modulus really is the product of two primes, which is what makes
      // the totient above the right one.
      const [p, q] = factorSemiprime(n);
      expect(p * q).toBe(n);
      expect(factorSemiprime(p * q)[0]).toBe(p);
    }
  });

  test('each shortest distance equals the cheapest of every simple path', () => {
    for (const { challenge, answer } of GRAPH_CASES) {
      const weights = challenge.adjacency.flatMap(row => row.out.map(edge => edge.weight));
      expect(weights.length).toBeGreaterThan(0);
      expect(weights.every(weight => weight > 0)).toBe(true);
      console.log(`    ${challenge.from} -> ${challenge.to} = ${String(answer)}`);
      expect(answer).toBe(cheapestSimplePath(challenge));
    }
  });

  test('the plaintext encodes back to the ciphertext, and Atbash is its own inverse', () => {
    console.log(`    ${CIPHER.ciphertext} -> ${CIPHER_ANSWER}`);
    expect(atbash(CIPHER_ANSWER)).toBe(CIPHER.ciphertext.toUpperCase());
    expect(atbash(atbash(CIPHER.ciphertext))).toBe(CIPHER.ciphertext.toUpperCase());
    // Every letter MOVED, which is why `toContain` on the live turn cannot be
    // satisfied by a response that merely quoted the ciphertext back.
    expect(letterKey(CIPHER_ANSWER)).not.toBe(letterKey(CIPHER.ciphertext));
    expect(letterKey(CIPHER_ANSWER).length).toBe(letterKey(CIPHER.ciphertext).length);
  });

  test('every prompt carries the data its answer was computed from', () => {
    // Rendered rather than transcribed, and this is what holds that true: a
    // number edited in the data and not in the prose is impossible, because
    // there is no prose copy of it.
    for (const { challenge } of RSA_CASES) {
      const prompt = rsaPrompt(challenge);
      for (const value of [challenge.n, challenge.e, challenge.c]) {
        expect(prompt).toContain(String(value));
      }
    }
    for (const { challenge } of GRAPH_CASES) {
      const prompt = graphPrompt(challenge);
      for (const row of challenge.adjacency) {
        for (const edge of row.out) {
          expect(prompt).toContain(`${edge.to}:${String(edge.weight)}`);
        }
      }
      expect(prompt).toContain(`from ${challenge.from} to ${challenge.to}`);
    }
    expect(cipherPrompt(CIPHER)).toContain(CIPHER.ciphertext);
  });

  test('the two instances of each family differ only in their numbers', () => {
    // What makes session 2 a transfer test rather than a second warm-up: one
    // template per family, so the pattern extracted in session 1 is the whole
    // of what carries over.
    const skeleton = (prompt: string): string => prompt.replace(/\d+/g, '#');
    expect(skeleton(RSA_CHALLENGE_1)).toBe(skeleton(RSA_CHALLENGE_2));
    expect(RSA_CHALLENGE_1).not.toBe(RSA_CHALLENGE_2);
  });
});
