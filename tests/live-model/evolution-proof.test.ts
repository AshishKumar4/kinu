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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  EvolutionEngine, historyTurnPairs,
  type LLMProviderConfig,
  type ToolCallRecord,
} from '../../packages/core/src/index';
import { type CLIRuntime } from '../../packages/cli-backend/src/runtime';
import { evalSession, type EvalSession, type LiveToolCall, type RequestSurfaceEvidence } from './harness';
import { provisionLocalTarget, type LocalTarget } from './target-local';
import { finalIntegerAnswer, letterKey,
liveModelTarget, recordLiveModelEpisode, reportLiveModelSpend,
UNCONFIGURED_LLM, } from '@kinu.run/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('Evolution Proof');

const liveTest = test.skipIf(!TARGET);


/** EXPOSURE, PRD §9.3's first of three metrics, with its own denominator, read from what session 2's turn was offered:
 *  not folded into reuse, since a reuse rate over an unexposed surface is a number about nothing. */
interface ExposureTally {
  /** Crafted tools session 1 left in the store. */
  readonly inherited: number;
  /** Of those, how many session 2's first turn was offered (`CompletedTurn.craftedOffered`). */
  readonly offered: number;
  /** Inherited names that turn was not offered. */
  readonly missing: readonly string[];
}

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'kinu-evolution-proof-' + Date.now());

type ReuseMode = 'instructed' | 'autonomous';

interface TurnResult {
  readonly turnId: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly calls: readonly LiveToolCall[];
  readonly steps: number;
  readonly durationMs: number;
  readonly reuseMode: ReuseMode;
  /** Crafted tools the turn's declarations offered, as the session recorded them. */
  readonly craftedOffered: readonly string[];
  /** Crafted tools the model's own programs called, as the session recorded them: binding and invocation, end to end. */
  readonly craftedUsed: readonly string[];
  /** What the PROVIDER was asked with, off the wire-level call options. PRD §9.5: a turn that made no delegation call
   *  has to carry the evidence that says whether it was offered one, or "the model declined" and "the harness never
   *  asked" stay the same observation. */
  readonly request: RequestSurfaceEvidence;
}

/** One challenge as a turn of the product's own session. */
async function proofTurn(agent: EvalSession, userMessage: string): Promise<TurnResult> {
  const asked = agent.requests.prompts().length;
  const { turnId, turn, text, calls } = await agent.turn(userMessage);
  const reuseMode: ReuseMode = /\b(?:must\s+)?use eval\b/i.test(userMessage) ? 'instructed' : 'autonomous';

  return {
    turnId, text, toolCalls: turn.toolCalls, calls, steps: turn.steps, durationMs: turn.durationMs,
    reuseMode, craftedOffered: turn.craftedOffered ?? [], craftedUsed: turn.craftedToolsUsed ?? [], request: agent.requests.evidence(asked),
  };
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
  return text.toUpperCase().replaceAll(/[A-Z]/gu, (letter) =>
    String.fromCharCode(LETTER_Z - (letter.charCodeAt(0) - LETTER_A)));
}

// ── Prompts, rendered from the data above ────────────────────────
//
// One template per family, so the session-1 instance and the session-2 instance
// differ ONLY in their numbers. That is what makes session 2 a transfer test:
// the pattern session 1 extracted is the whole of what carries over.

function rsaPrompt({ n, e, c }: RsaChallenge): string {
  return `
Solve this RSA crypto challenge. You MUST use eval to compute the answer.

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
Implement Dijkstra's shortest path algorithm and solve this problem. Use eval.

Graph (adjacency list with weights):
${rows}

Find the shortest distance from ${from} to ${to}. Return ONLY the number.
`;
}

function cipherPrompt({ ciphertext }: CipherChallenge): string {
  return `
Decode this substitution cipher. Use eval to try frequency analysis.

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

/** A turn whose answer the proof checked, rated as the user would: a thumbs-up. */
describe('Evolution Proof', () => {
  let rt: CLIRuntime;
  let target: LocalTarget;
  /** Only for the owner's thumb: the session has no entry point for one, and `applyExplicitFeedback` writes the same
   *  row `setTurnFeedback` does, against the turn's own record. */
  let engine: EvolutionEngine;
  /** The session the challenges are turns of: session 1's, then a fresh one for session 2, as two `kinu` runs. */
  let agent: EvalSession | undefined;
  let drove = false;

  /** The proof checked the turn's answer, so it rates it as the owner would: a thumb, before the next message arrives,
   *  whose arrival runs the review that reads it. */
  const rateAsChecked = async (turnId: string): Promise<void> => {
    await engine.applyExplicitFeedback(turnId, 'positive');
    checked.push(turnId);
  };

  /** The turns whose answers checked, so rated: a turn answered wrongly is not, and fails its own arm. */
  const checked: string[] = [];

  const session = (): EvalSession => {
    agent ??= evalSession({ rt, db: target.db, llm: LLM_CONFIG });
    drove = true;

    return agent;
  };

  beforeAll(async () => {
    // Provisioned through the seam: birth, the whole schema, open, the executor-surface and sandbox guards and the
    // pre-turn profile, the same sequence every live suite drives, once. The real runtime rather than the birth one,
    // so evolution reaches a genuine branch spawner.
    target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'evolution-proof',
      purpose: 'A crypto and algorithm expert that solves CTF-style challenges using code execution.',
      llm: LLM_CONFIG,
    });
    rt = target.runtime;
    engine = new EvolutionEngine(rt, historyTurnPairs(rt.stores.history), { enabled: true });
  });

  afterAll(async () => {
    await agent?.end();

    if (drove) recordLiveModelEpisode(rt.storage.sql, rt.actor);
    reportLiveModelSpend('Evolution Proof');
    // Teardown owns the store and the directory.
    target?.teardown();
  });

  // ── SESSION 1: Solve challenges, build patterns ──────────────

  const session1Results: TurnResult[] = [];

  liveTest('session 1, turn 1: RSA challenge (learn the pattern)', async () => {
    const result = await proofTurn(session(), RSA_CHALLENGE_1);
    // The request evidence, per turn, from the wire: what the provider was offered and whether the delegation index
    // was in the system message it received. Printed on the FIRST turn, where a broken projection is cheapest to see.
    console.log(`    request: ${String(result.request.calls)} call(s), tools offered `
      + `${result.request.toolsOffered.join(', ')}, agents=${String(result.request.agentsOffered)}, `
      + `agents indexed=${String(result.request.agentsIndexed)}, `
      + `system ${String(result.request.systemChars)} chars`);
    expect(result.request.calls).toBeGreaterThan(0);
    expect(result.request.toolsOffered).toContain('eval');
    expect(result.request.agentsOffered).toBe(true);
    expect(result.request.agentsIndexed).toBe(true);
    expect(result.request.runtimeFacts).toBe(true);
    session1Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.toolCalls.some(tc => tc.name === 'eval')).toBe(true);

    // THE FLAG. Exactly checkable, and computed by this file's own solver from
    // the same numbers the prompt above was rendered from.
    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(RSA_ANSWER_1)}`);
    expect(answered).toBe(RSA_ANSWER_1);
    await rateAsChecked(result.turnId);
  }, 0);

  liveTest('session 1, turn 2: Dijkstra challenge (learn algorithm pattern)', async () => {
    const result = await proofTurn(session(), DIJKSTRA_CHALLENGE_1);
    session1Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);

    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(DIJKSTRA_ANSWER_1)}`);
    expect(answered).toBe(DIJKSTRA_ANSWER_1);
    await rateAsChecked(result.turnId);
  }, 0);

  liveTest('session 1, turn 3: cipher challenge', async () => {
    const result = await proofTurn(session(), CIPHER_CHALLENGE);
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
    expect(letterKey(result.text)).toContain(CIPHER_ANSWER.replaceAll(' ', ''));
    await rateAsChecked(result.turnId);

    // A turn is reviewed when the next message arrives; the last challenge's is this closing one, as an owner says it.
    await session().turn('Thanks, that is all for today.');
    // Session 1 ends as a `kinu` run ends; session 2 is a fresh one over the same workspace.
    await agent?.end();
    // What session 1's own evolution said it did, so an empty store below reads as declined or as never asked.
    const evolved = (agent?.events ?? []).flatMap((event) => (event.type === 'evolution' ? [`${event.event}: ${event.message.slice(0, 80)}`] : []));
    console.log(`    Session 1 evolution: ${evolved.join(' | ') || '(none)'}`);
    agent = undefined;
  }, 0);

  // ── Verify evolution happened ────────────────────────────────

  liveTest('evolution artifacts exist after session 1', async () => {
    // THE DENOMINATOR, first, because every claim below is about what the RATED turns produced. A proof drives
    // challenges and never replies, so it rates each turn whose answer it checked with a thumb; a pattern is extracted
    // only from a turn rated high that ran tools, by the review the next message runs.
    const thumbs = rt.storage.sql<{ turn_id: string; score: number }>`
      SELECT turn_id, score FROM turn_ratings WHERE source = 'thumbs'`;

    const ratedThatRanTools = session1Results.filter(r => checked.includes(r.turnId) && r.toolCalls.length > 0).length;
    console.log(`    Rated turns: ${thumbs.map(r => `${r.turn_id}:${String(r.score)}`).join(', ')}`);
    expect(ratedThatRanTools).toBeGreaterThan(0);
    expect(thumbs.map((row) => ({ turnId: row.turn_id, score: row.score })).sort((a, b) => a.turnId.localeCompare(b.turnId)))
      .toEqual(checked.map((turnId) => ({ turnId, score: 5 })).sort((a, b) => a.turnId.localeCompare(b.turnId)));

    // WHAT THE RUN RECORDED, as content rather than as a size: the artifact evolution produces from an ACCEPTED turn.
    // extractPattern generalizes the turn's tool calls and upsertCraftedTool admits the result only after compiling it
    // to a callable (craft/conflict.ts, upsertCraftedTool). Asserted per tool, because a count alone is what let a
    // stored "tool" whose body was `await ({ runtime })(…)` read as an artifact.
    const crafted = rt.craftStore.list();

    const chosen = new Map(rt.storage.sql<{ name: string; chosen: number }>`
      SELECT name, chosen FROM crafted_tools`.map(r => [r.name, r.chosen]));

    console.log(`    Crafted tools: ${crafted.length}`);
    expect(crafted.length).toBeGreaterThan(0);

    for (const t of crafted) {
      console.log(`      ${t.name} (chosen ${String(chosen.get(t.name))}): ${t.description.slice(0, 60)}`);
      console.log(`        code: ${t.code.slice(0, 80)}...`);
      // Named, so a later turn can ask for it by name.
      expect(t.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      // CALLABLE, compiled exactly as the CLI invokes a crafted tool. The store's own admission gate ran this before the
      // write; running it here is what makes "3 crafted tools" a claim about artifacts rather than about rows.
      expect(new Function(`return (${t.code})`)()).toBeInstanceOf(Function);
      // Counted on its own row, which consolidation reads to retire a tool no turn chooses (craft/preference.ts).
      expect(chosen.has(t.name)).toBe(true);
    }

    // Memory itself: the birth record is still there. Nothing in these accepted turns writes MEMORY.md; only the
    // agent's own notes do.
    const memory = await rt.memory.read('memory/MEMORY.md');

    if (!memory) throw new Error('the workspace lost memory/MEMORY.md between birth and this read');
    console.log(`    Memory (${memory.length} chars): ${JSON.stringify(memory.slice(0, 120))}`);
    expect(memory).toContain('# evolution-proof');

    // Both halves of every turn, the closing one included, are on the conversation the next session reads.
    const msgCount = rt.storage.sql<{ c: number }>`SELECT COUNT(*) as c FROM conversation_entries`[0]?.c ?? 0;
    console.log(`    Messages: ${msgCount}`);
    expect(msgCount).toBeGreaterThanOrEqual((session1Results.length + 1) * 2);
  });

  // ── SESSION 2: Similar challenges — should benefit from evolution ──

  const session2Results: TurnResult[] = [];
  let inheritedToolNames: string[] = [];
  /** Filled by session 2's first turn, reported beside the two reuse rates in the summary. `null` until then, so a
   *  summary over a session-2 turn that never ran says so instead of printing zeros. */
  let exposure: ExposureTally | null = null;

  liveTest('session 2, turn 1: similar RSA challenge with inherited artifacts', async () => {
    // What session 2 inherits, from the store it inherits it in. Crafted tools are sandbox-only, reached as
    // `tools.<name>` inside `eval` and declared to the model in the turn's dynamic block, so the transfer is asserted
    // on that declaration rather than counted from the tool list.
    inheritedToolNames = rt.craftStore.list().map(t => t.name);
    console.log(`    Crafted tools inherited from session 1: ${inheritedToolNames.join(', ')}`);
    expect(inheritedToolNames.length).toBeGreaterThan(0);

    const result = await proofTurn(session(), RSA_CHALLENGE_2);
    session2Results.push(result);

    // ── EXPOSURE, read from what the turn was offered ───────────────────────
    // PRD §9.3 separates EXPOSURE from reuse: a reuse rate over a surface that never offered the tools is a number
    // about nothing. Read off the turn's own record, never probed by a program of this suite's: a probe run through
    // the session would sit in the conversation the measured turns read, naming the tools they are scored on reusing.
    const missing = inheritedToolNames.filter((name) => !result.craftedOffered.includes(name));
    exposure = { inherited: inheritedToolNames.length, offered: inheritedToolNames.length - missing.length, missing };
    console.log(`    exposure: ${String(exposure.offered)}/${String(exposure.inherited)} offered, missing ${missing.join(', ') || '(none)'}`);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(missing).toEqual([]);
    expect(result.text.length).toBeGreaterThan(0);

    // The transfer has to be a transfer of something CORRECT. A session-2 turn
    // that reused a crafted tool and answered wrongly is evidence against the
    // pattern, not for it.
    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(RSA_ANSWER_2)}`);
    expect(answered).toBe(RSA_ANSWER_2);
  }, 0);

  liveTest('session 2, turn 2: similar graph challenge with inherited artifacts', async () => {
    const result = await proofTurn(session(), DIJKSTRA_CHALLENGE_2);
    session2Results.push(result);

    console.log(`    Response: ${result.text.slice(0, 200)}`);
    console.log(`    Steps: ${result.steps}, Tools: ${result.toolCalls.map(t => t.name).join(', ')}`);
    console.log(`    Duration: ${result.durationMs}ms`);

    expect(result.text.length).toBeGreaterThan(0);

    const answered = finalIntegerAnswer(result.text);
    console.log(`    Answered ${String(answered)}, expected ${String(DIJKSTRA_ANSWER_2)}`);
    expect(answered).toBe(DIJKSTRA_ANSWER_2);
  }, 0);

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
    const msgCount = rt.storage.sql<{ c: number }>`SELECT COUNT(*) as c FROM conversation_entries`[0]?.c ?? 0;
    const craftCount = rt.storage.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`[0]?.c ?? 0;
    console.log(`\n    DB: ${msgCount} messages, ${craftCount} crafted tools`);

    console.log('    ═══ END SUMMARY ═══\n');

    expect(session1Results.every(r => r.text.length > 0)).toBe(true);
    expect(session2Results.every(r => r.text.length > 0)).toBe(true);
    expect(s1Tools).toBeGreaterThan(0);

    // THREE metrics, three denominators, PRD §9.3. Exposure is not a kind of
    // reuse: it is whether the mechanism was reachable at all, and folding it in
    // is what let a run report reuse over a surface where `tools.<name>` was
    // undefined. Reuse then splits by population, because these challenge
    // prompts explicitly command `use eval` — so this proof measures
    // INSTRUCTED transfer, and the behaviour eval's corpus, which mechanically
    // forbids that instruction, measures autonomous transfer. A missing
    // autonomous opportunity is `n/a`, never a zero folded into this rate.
    if (!exposure) throw new Error('the exposure block did not run, so no reuse rate here has a denominator');
    console.log(`    Exposure: ${String(exposure.offered)}/${String(exposure.inherited)} offered`);

    interface ReuseTally {
      eligible: number;
      passed: number;
    }

    interface ReuseByMode {
      instructed: ReuseTally;
      autonomous: ReuseTally;
    }

    const reuseByMode: ReuseByMode = {
      instructed: { eligible: 0, passed: 0 },
      autonomous: { eligible: 0, passed: 0 },
    };

    for (const result of session2Results) {
      const bucket = reuseByMode[result.reuseMode];
      bucket.eligible += 1;

      // Read off the session's record of what the model's own programs called, so a reuse is a binding that resolved and
      // a body that ran, end to end.
      const reusedInherited = result.craftedUsed.some((name) => inheritedToolNames.includes(name));

      if (reusedInherited) bucket.passed += 1;
    }

    console.log(`    Instructed reuse: ${String(reuseByMode.instructed.passed)}/`
      + `${String(reuseByMode.instructed.eligible)}`);
    console.log(`    Autonomous reuse: ${reuseByMode.autonomous.eligible === 0
      ? 'n/a — no autonomous turn in this proof'
      : `${String(reuseByMode.autonomous.passed)}/${String(reuseByMode.autonomous.eligible)}`}`);

    // The delegation surface, per turn, from the requests themselves. Asserted
    // over EVERY turn rather than the first: a surface rebuilt mid-run, or a
    // prompt whose section disappeared once `sectionOverrides` changed, would
    // otherwise pass on turn one and go unmeasured afterwards.
    const shownEveryTurn = [...session1Results, ...session2Results]
      .every((turn) => turn.request.agentsOffered && turn.request.agentsIndexed);

    console.log(`    Delegation surface shown on every turn: ${String(shownEveryTurn)}`);

    // EXPOSURE first, because it is the denominator's precondition.
    expect(exposure.offered).toBe(exposure.inherited);
    expect(shownEveryTurn).toBe(true);
    expect(reuseByMode.instructed.eligible).toBe(session2Results.length);
    expect(
      reuseByMode.instructed.passed,
      'session 2 did not call any crafted tool from session 1',
    ).toBeGreaterThan(0);
    expect(reuseByMode.autonomous.eligible).toBe(0);
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
    // A hand-known pair pins the mapping itself: ROT13 and an alphabet off by one pass the round trip too,
    // and would define a wrong expected plaintext that a correct decoding then fails.
    expect(atbash('WIZARD')).toBe('DRAZIW');
    expect(atbash(CIPHER_ANSWER)).toBe(CIPHER.ciphertext.toUpperCase());
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

});
