/**
 * E2E lifecycle test — real LLM, real SQLite, native AI SDK tool calling.
 *
 * WHAT THIS CERTIFIES: the CORE TURN LOOP, and only that. `chatTurn` below
 * calls `generateText` with a system prompt, a tool set and a threaded message
 * list — so what is proven here is that soul and memory reach the model, that
 * native tool calling round-trips, that a conversation accumulates, and that
 * evolution and MCTS run over the turns it produces. It is an INNER API by
 * construction: it does not go through turn assembly, the reactor, backgrounding
 * wakes or the prompt cache, so a green run here is never a statement that the
 * shipped agent works.
 *
 * WHAT COVERS THAT GAP: the eval tier's shipped-surface arms, which drive the
 * SPAWNED `kinu` CLI on a real workspace — `tests/evals/research.eval.ts`
 * and `tests/evals/optimization.eval.ts` through `tests/evals/cli-driver.ts`
 * (`kinu create --mode local`, then `kinu exec --workspace <name>
 * --json`), on the precedent of bench/harbor/kinu_agent.py. Read a failure
 * here as "the loop broke"; read a failure there as "the product broke".
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateText, stepCountIs,
  type LanguageModel, type ModelMessage, type ToolSet, type StepResult,
} from 'ai';
import * as v from 'valibot';

import {
  collectStepText,
  EvolutionEngine,
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
import { openWorkspaceCLI } from '../packages/cli-backend/src/open';
import type { CLIRuntime } from '../packages/cli-backend/src/runtime';
import { buildEvalAgentSurface } from './evals/harness';
import { provisionLocalTarget, type LocalAgentEvalTarget } from './evals/target-local';
import {
  EVAL_BACKEND_ENV, liveChatModel, liveModelCallSink, liveModelTarget, recordLiveModelEpisode,
  recordLiveModelSpend, reportLiveModelSpend, resolveEvalBackend, UNCONFIGURED_LLM,
} from '@kinu.run/test-utils';

/**
 * THIS SUITE IS THE IN-PROCESS LOOP, and it reads the target knob to say so.
 *
 * `chatTurn` below calls `generateText` over a `CLIRuntime` and drives
 * `EvolutionEngine` and `runMCTS` directly, so every assertion here is about the
 * inner API. A deployed workspace hands out no runtime, so this suite cannot
 * answer the cloud target's questions at all — and running it under
 * `KINU_EVAL_BACKEND=cloud` would report an in-process measurement inside a
 * cloud arm's banner, with a `-cloud` report filename to match. That is the one
 * error `tests/evals/target.ts` exists to remove, so the refusal is here rather
 * than only in the tier's arm list: `scripts/eval-tier.sh` does not name this
 * file on the cloud arm, and a shell that exports the variable by hand gets a
 * named skip instead of a mislabelled green.
 *
 * The cross-target claim about `@cloudflare/think` belongs to
 * `tests/evals/swarm.eval.ts`, whose cross-target arm provisions through the
 * seam and drives whichever loop the plan named.
 */
const BACKEND = resolveEvalBackend();
if (BACKEND.kind === 'refused') throw new Error(`E2E Lifecycle: ${BACKEND.reason}`);
const IN_PROCESS = BACKEND.backend === 'local';
if (!IN_PROCESS) {
  console.warn(`[skip] E2E Lifecycle — ${EVAL_BACKEND_ENV}=cloud, and this suite certifies the `
    + 'in-process turn loop over a CLIRuntime, which a deployed workspace does not hand out. '
    + 'Unset it to run this suite; tests/evals/swarm.eval.ts is the arm that runs on both.');
}

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = IN_PROCESS ? liveModelTarget('E2E Lifecycle') : null;
const liveTest = test.skipIf(!TARGET);
/** The credential-free arm still needs the in-process store, so it is gated on
 *  the knob rather than on a credential. */
const inProcessTest = test.skipIf(!IN_PROCESS);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'kinu-e2e-' + Date.now());
const DB_PATH = join(TEST_DIR, 'agent.db');

/** One turn's result, plus the exact message list that turn HANDED THE MODEL. */
interface ConversationTurn {
  readonly turn: CompletedTurn;
  readonly sent: readonly ModelMessage[];
}

/**
 * One turn of a CONVERSATION: `history` is the running message list, extended
 * in place with this turn's user message and everything the model produced —
 * assistant text and tool traffic — exactly as the AI SDK hands it back.
 *
 * It used to take one string and send `messages: [user]`, so "5-turn
 * conversation" was five one-turn conversations wearing that title: turn 5
 * asked "Summarize what we discussed", the model honestly answered "We haven't
 * actually discussed anything yet", and the test PASSED, because the only
 * per-turn assertion was `length > 0`. The history is the subject of that
 * suite's title, so it is threaded here, once, for every caller.
 *
 * `sent` IS RETURNED BECAUSE CONTENT CANNOT PROVE THREADING. The agent holds a
 * `memory` tool whose conversation-search action queries the same `messages`
 * table this function writes to (core/src/tools/memory-tool.ts over
 * core/src/memory/conversation-search.ts), so a later turn can RETRIEVE the
 * conversation whether or not it was threaded. Measured 2026-08-20: with
 * `messages: [user]` restored — history built but never handed over — turn 5
 * still answered "Here's a summary of our previous discussion" and reproduced
 * turn 1's code verbatim, while the injected knowledge was 118 characters
 * holding only turn 3's note. Two unthreaded runs scored 6/0 and 5/1: the
 * content assertions are real, but they are not a DETERMINISTIC red for
 * threading, because a second channel can satisfy them. The prompt itself is
 * the only witness that cannot, so the suite asserts on it too.
 */
async function chatTurn(
  model: LanguageModel,
  rt: AgentRuntime,
  tools: ToolSet,
  history: ModelMessage[],
  userMessage: string,
): Promise<ConversationTurn> {
  const start = Date.now();
  const soul = await readSoul(rt.storage.vfs) ?? '';
  const knowledge = (await rt.memory.read('memory/MEMORY.md'))?.slice(0, 1500) ?? '';

  const tcRecords: ToolCallRecord[] = [];
  let steps = 0;

  history.push({ role: 'user', content: userMessage });
  // Snapshotted BEFORE the call and returned: `history` keeps growing in place,
  // so reading it afterwards would report what the NEXT turn will send.
  const sent: readonly ModelMessage[] = [...history];
  const result = await generateText({
    model,
    system: `${soul}\n\nKnowledge:\n${knowledge}`,
    messages: history,
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
  // The turn's own output — assistant text AND tool call/result messages —
  // exactly as the SDK shaped them, so the next turn's model sees this one.
  history.push(...result.response.messages);
  const responseText = collectStepText(result);
  const id = crypto.randomUUID();
  void rt.storage.sql`INSERT INTO messages (id, session_id, role, content) VALUES (${id}, ${'e2e'}, ${'user'}, ${userMessage})`;
  void rt.storage.sql`INSERT INTO messages (id, session_id, parent_id, role, content) VALUES (${crypto.randomUUID()}, ${'e2e'}, ${id}, ${'assistant'}, ${responseText})`;

  return {
    sent,
    turn: {
      userMessage, assistantResponse: responseText, toolCalls: tcRecords,
      steps, durationMs: Date.now() - start, feedback: null, hadError: false,
    },
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
  let rt: CLIRuntime;
  let tools: ToolSet;
  let engine: EvolutionEngine;
  let events: EvolutionEvent[];
  let turns: CompletedTurn[];
  let model: LanguageModel;
  let target: LocalAgentEvalTarget;

  beforeAll(async () => {
    // Nothing is provisioned on the cloud knob: a local workspace opened here
    // would be an in-process store standing inside a cloud-labelled run, which
    // is the mislabelling the skip above refuses.
    if (!IN_PROCESS) return;
    // PROVISIONED THROUGH THE SEAM. Birth, the whole-schema init, `openWorkspaceCLI`
    // with `hostRoot: null`, the executor-surface and sandbox guards and
    // `installPreTurnProfile` were spelled out here and identically in three sibling
    // suites. Each step has a measured failure behind it — a hand-picked schema
    // subset that omitted `initShadowTables` and killed a sibling mid-run, a birth
    // runtime whose `spawnBranch` throws by design so `MCTS evolution` below could
    // never pass, a default executor plane rooted at the repo this suite was
    // launched from, and an unwired runtime whose every routed lane is dead so
    // `reviewTurn`/`converge` throw before reaching a model. All four now live in
    // ONE place instead of four, which is the point: a step learned once had to be
    // remembered four times.
    target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'e2e-test',
      purpose: 'A coding assistant that helps write TypeScript.',
      llm: LLM_CONFIG,
      model: liveChatModel(LLM_CONFIG),
      evolution: true,
    });
    rt = target.runtime;
    db = target.db;
    events = [];
    engine = new EvolutionEngine(rt, { enabled: true });
    engine.onEvent(e => events.push(e));
    turns = [];

    // Model first: the production actor root builds `agents` from deps carrying
    // the model a search expands with, so a surface built before it would be the
    // product's minus its delegation tool.
    model = liveChatModel(LLM_CONFIG);
    tools = buildEvalAgentSurface({ rt, model, llm: LLM_CONFIG }).tools;
  });

  afterAll(async () => {
    // NOT recorded here, and the reason is measured rather than stylistic. This
    // suite already records its episode inside the arm that drives one, at the
    // moment that call returns. Recording again in teardown double-counted every
    // live figure — and on a CREDENTIAL-FREE run, where the target is provisioned
    // but no arm ever drives it, it reported `1 episode(s) UNMEASURED`: a suite
    // announcing it drove work whose cost it could not account for, when it had
    // driven none. An honest meter must not fire on a run that spent nothing.
    reportLiveModelSpend('E2E Lifecycle');
    // Teardown owns the store and the directory. On a cloud target the same call
    // DELETES the workspace, which is why it belongs to the target.
    await target?.teardown();
  });

  inProcessTest('agent created with correct tables', async () => {
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
    // ONE history, threaded through every turn — the conversation the title
    // claims. `length > 0` was the only per-turn assertion before, and it
    // passed a turn-5 response of "We haven't actually discussed anything yet".
    //
    // The judgements below come in two kinds, and the split is deliberate. The
    // MECHANISM assertions read the prompt each turn handed the model: they are
    // the deterministic red for threading. The BEHAVIOUR assertions read the
    // replies: they prove the model USED its context, but they are not proof of
    // threading, because the `memory` tool searches the same `messages` table
    // this suite writes and can fetch the conversation back (measured — see
    // chatTurn's header). Both are kept: a suite that only checked the
    // mechanism would pass on a model that ignored what it was handed.
    const history: ModelMessage[] = [];
    const messages = [
      // Named so turn 2's judgement is mechanical: turn 2's own prompt never
      // says "sortNumbers".
      'Write a TypeScript function named sortNumbers that sorts an array of numbers.',
      'Now add error handling for non-array inputs.',
      'Save a note to your memory: always validate input types in utility functions.',
      'Search your memory for notes about validation.',
      'Summarize what we discussed.',
    ];
    const sentPerTurn: (readonly ModelMessage[])[] = [];
    for (const [i, message] of messages.entries()) {
      console.log(`  Turn ${i + 1}: ${message.slice(0, 50)}...`);
      const { turn, sent } = await chatTurn(model, rt, tools, history, message);
      sentPerTurn.push(sent);
      turns.push(turn);
      await engine.reviewTurn(turn, null);
      expect(turn.assistantResponse.length).toBeGreaterThan(0);
      console.log(`    Response: ${turn.assistantResponse.slice(0, 80)}...`);
      if (turn.toolCalls.length > 0) console.log(`    Tools: ${turn.toolCalls.map(t => t.name).join(', ')}`);
    }

    // ── The MECHANISM: the conversation was actually HANDED OVER ────────────
    // This is the assertion that makes the suite's title true, and the only one
    // that is a deterministic red when the history is not threaded. It reads
    // the prompt each turn SENT, never the store and never the reply, because
    // the agent's `memory` tool searches the same `messages` table this suite
    // writes — so a later turn can retrieve the conversation without ever
    // having been given it (see chatTurn's header for the measurement).
    for (const [i, sent] of sentPerTurn.entries()) {
      expect(sent.length,
        `turn ${String(i + 1)} was handed ${String(sent.length)} message(s) but should carry every `
        + 'earlier exchange plus its own prompt — a turn sent only its own prompt is a one-turn '
        + 'conversation, which is the defect this suite exists to catch')
        .toBeGreaterThan(i);
    }
    const lastSent = sentPerTurn[4];
    if (!lastSent) throw new Error('turn 5 recorded no prompt');
    expect(JSON.stringify(lastSent),
      'turn 5 was handed no message carrying turn 1 — "Summarize what we discussed" reached the '
      + 'model with nothing to summarize, so these were five one-turn conversations wearing the '
      + 'title of one')
      .toContain('sortNumbers');

    // ── The BEHAVIOUR: the model used what it was handed ────────────────────
    // Turn 2 continues turn 1's work; its own prompt never says "sortNumbers".
    const followUp = turns[1];
    if (!followUp) throw new Error('turn 2 was never recorded');
    expect(followUp.assistantResponse,
      'turn 2 does not reference sortNumbers — the turn-1 function never reached its context, '
      + 'so this was two separate conversations, not one').toContain('sortNumbers');

    // Turn 4's search FINDS the note turn 3 saved — asserted on the TOOL
    // RESULT, not the prose, because with a threaded history the model could
    // echo the note from context while the search returned nothing. "input
    // types" is a phrase of the note that turn 4's own prompt never says. If
    // FTS stemming makes "validation" miss "validate", this goes red and that
    // is a PRODUCT finding to fix in the search, not a prompt to soften.
    const search = turns[3];
    if (!search) throw new Error('turn 4 was never recorded');
    expect(search.toolCalls.length,
      'turn 4 called no tool at all — "Search your memory" was answered from context, not memory')
      .toBeGreaterThan(0);
    const hits = search.toolCalls.filter((call) =>
      JSON.stringify(call.result ?? '').includes('input types'));
    expect(hits.length,
      `turn 4's memory search never returned the note turn 3 saved — searched via `
      + `${search.toolCalls.map((call) => call.name).join(', ')}, and no tool result carried `
      + `"input types"`).toBeGreaterThan(0);

    // Turn 5 summarizes THIS conversation: at least two of the discussed
    // topics, by name. A model with no history answers that nothing was
    // discussed, which is exactly the red this assertion exists to produce.
    const summary = turns[4];
    if (!summary) throw new Error('turn 5 was never recorded');
    expect(summary.assistantResponse,
      'turn 5\'s summary never mentions sorting — the discussed work did not reach it')
      .toMatch(/sort/i);
    expect(summary.assistantResponse,
      'turn 5\'s summary never mentions validation or input types — the discussed work did not reach it')
      .toMatch(/validat|input type/i);

    const count = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
    console.log(`  Messages in DB: ${count}`);
    expect(count).toBeGreaterThanOrEqual(10);
    // 30 minutes, RAISED FROM 600_000 ON A MEASUREMENT. Threading the history
    // lengthens every turn — the model now works from the conversation instead
    // of restarting — and the turns are tool-using: measured 2026-08-20 on
    // @cf/deepseek-ai/deepseek-v4-pro, turn 2 alone spent 12 tool calls
    // (`file, file, run × 9, file`) and two consecutive runs hit the old cap
    // at 600_008ms and 600_003ms, so a conversation that was going to pass was
    // being reported as a timeout. The green run of the same suite took
    // 1155s end to end. This is headroom over a measured ~19-minute worst
    // case, not a number picked to make a red go away.
  }, 1_800_000);

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
    const result = await runMCTS(rt, session, 'How can I improve as a TypeScript assistant?', {
      budget: 1, branches: 2, maxCostUSD: 5,
      // Every other test here holds an SDK result and reports it directly. A search
      // does not: its rollouts and judge samples are made deeper down, so with no
      // sink they happen and go unattributed — this step ran for 456s and reported
      // `0 model call(s)`, which is the floor-as-a-total shape the tier's own
      // liveness verdict refuses.
      reportModelCall: liveModelCallSink(rt.storage.sql),
    });
    recordLiveModelEpisode(rt.storage.sql);
    const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
    console.log(`  Nodes: ${nodes.length}`);
    expect(nodes.length).toBe(3);
    expect(nodes.some((node) => node.id === result.winnerId)).toBe(true);
    // The search is already at its floor — `budget: 1, branches: 2` is the
    // smallest shape that can produce the three nodes asserted above — so the
    // ceiling is what had to move. It was 300s against a step MEASURED at 290s
    // one run and killed past 300s the next, which is a coin toss rather than a
    // gate. Per-call latency on @cf/deepseek-ai/deepseek-v4-pro-0813 spans 22s to
    // 293s inside a single run of this very suite, so a ceiling needs multiples
    // of the measurement and not percent. 900s is what the sibling MCTS step in
    // `exploration.eval.test.ts` uses, and these two are the same kind of step.
  }, 900_000);

  liveTest('persistence', async () => {
    const msgsBefore = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
    db.close();
    const db2 = new Database(DB_PATH);
    const msgsAfter = db2.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
    const reopened = await openWorkspaceCLI(db2, DB_PATH, { llm: LLM_CONFIG });
    const soul = reopened.info.soul;
    db2.close();
    expect(msgsAfter).toBe(msgsBefore);
    expect(soul).toContain('TypeScript');
    db = new Database(DB_PATH);
  });
});
