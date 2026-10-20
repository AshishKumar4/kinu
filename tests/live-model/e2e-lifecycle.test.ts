/**
 * E2E lifecycle test — real LLM, real SQLite, the product's own session.
 *
 * WHAT THIS CERTIFIES: the local session's turn loop, as `kinu` runs it. Each turn goes through
 * `LocalAgentSession`: its prompt, its tool surface, its history and its evolution are the product's, so what is
 * proven here is that soul and memory reach the model, that native tool calling round-trips, that a conversation
 * accumulates, and that evolution runs over the turns it produces.
 *
 * WHAT COVERS THE REST: the eval suite (evals/), which drives the DEPLOYED product through the surfaces a person uses
 * and checks what the agent built. Read a failure here as "the local loop broke"; read a failure there as "the
 * deployed product broke".
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type LLMProviderConfig,
  type CompletedTurn,
} from '../../packages/core/src/index';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { soulIn, type CLIRuntime } from '../../packages/cli-backend/src/runtime';
import { evalSession, type EvalSession, type LiveToolCall } from './harness';
import { localTargetFolder, provisionLocalTarget, type LocalTarget } from './target-local';
import { EVAL_BACKEND_ENV, liveChatModel, liveModelTarget,
recordLiveModelEpisode, reportLiveModelSpend, resolveEvalBackend, UNCONFIGURED_LLM, workspaceDatabase,
} from '@kinu.run/test-utils';

/**
 * THIS SUITE IS THE IN-PROCESS LOOP, and it reads the target knob to say so.
 *
 * The session below runs over a `CLIRuntime`, so every assertion here is about
 * the in-process loop. A deployed workspace hands out no runtime, so this suite cannot
 * answer the cloud target's questions at all — and running it under
 * `KINU_EVAL_BACKEND=cloud` would report an in-process measurement inside a
 * cloud arm's banner, with a `-cloud` report filename to match. So the refusal
 * is here rather than only in the tier's argv: `scripts/live-tier.sh` does not
 * name this file under `--backend cloud`, and a shell that exports the variable
 * by hand gets a named skip instead of a mislabelled green.
 */
const BACKEND = resolveEvalBackend();

if (BACKEND.kind === 'refused') throw new Error(`E2E Lifecycle: ${BACKEND.reason}`);

const IN_PROCESS = BACKEND.backend === 'local';

if (!IN_PROCESS) {
  console.warn(`[skip] E2E Lifecycle — ${EVAL_BACKEND_ENV}=cloud, and this suite certifies the `
    + 'in-process turn loop over a CLIRuntime, which a deployed workspace does not hand out. '
    + 'Unset it to run this suite.');
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

describe('E2E Lifecycle', () => {
  let db: InstanceType<typeof Database>;
  let rt: CLIRuntime;
  let turns: CompletedTurn[];
  let callsPerTurn: (readonly LiveToolCall[])[];
  let target: LocalTarget;
  /** The product's own session over the workspace, as `kinu` runs it: its prompt, its history, its evolution. */
  let agent: EvalSession | undefined;

  beforeAll(async () => {
    // Nothing is provisioned on the cloud knob: a local workspace opened here would be an in-process store standing
    // inside a cloud-labelled run, which is the mislabelling the skip above refuses.
    if (!IN_PROCESS) return;
    // PROVISIONED THROUGH THE SEAM: birth, the whole-schema init, `openWorkspaceCLI` with no directory bound, the
    // executor-surface and sandbox guards and the pre-turn profile, in one place for every live suite.
    target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'e2e-test',
      purpose: 'A coding assistant that helps write TypeScript.',
      llm: LLM_CONFIG,
    });
    rt = target.runtime;
    db = target.db;
    turns = [];
    callsPerTurn = [];
  });

  afterAll(async () => {
    await agent?.end();
    // NOT recorded here: the arm that drives the episode records it when it returns. Recording again in teardown
    // double-counted every live figure, and on a credential-free run reported an unmeasured episode that never ran.
    reportLiveModelSpend('E2E Lifecycle');
    // Teardown owns the store and the directory.
    target?.teardown();
  });

  inProcessTest('agent created with its SOUL.md', async () => {
    const soul = soulIn(rt.space) ?? '';
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
    // threading, because the `memory` tool searches the conversation the session
    // records and can fetch it back (measured 2026-08-20: an unthreaded turn 5
    // still summarised turn 1 through it). Both are kept: a suite that only checked
    // the mechanism would pass on a model that ignored what it was handed.
    agent = evalSession({ rt, db, model: liveChatModel(LLM_CONFIG) });

    const messages = [
      // Named so turn 2's judgement is mechanical: turn 2's own prompt never
      // says "sortNumbers".
      'Write a TypeScript function named sortNumbers that sorts an array of numbers.',
      'Now add error handling for non-array inputs.',
      'Save a note to your memory: always validate input types in utility functions.',
      'Search your memory for notes about validation.',
      'Summarize what we discussed.',
    ];

    // The prompt each turn's first request carried, as the provider received it.
    const sentPerTurn: string[] = [];

    for (const [i, message] of messages.entries()) {
      console.log(`  Turn ${i + 1}: ${message.slice(0, 50)}...`);
      const asked = agent.requests.prompts().length;
      const { turn, calls } = await agent.turn(message);
      sentPerTurn.push(agent.requests.prompts().slice(asked).find((prompt) => prompt.includes(message)) ?? '');
      turns.push(turn);
      callsPerTurn.push(calls);
      expect(turn.assistantResponse.length).toBeGreaterThan(0);
      console.log(`    Response: ${turn.assistantResponse.slice(0, 80)}...`);

      if (turn.toolCalls.length > 0) console.log(`    Tools: ${turn.toolCalls.map(t => t.name).join(', ')}`);
    }

    recordLiveModelEpisode(rt.storage.sql, rt.actor);

    // ── The MECHANISM: the conversation was actually HANDED OVER ────────────
    // The deterministic red for threading reads the prompt each turn SENT, never the store and never the reply: the
    // agent's `memory` tool searches the same conversation the session records, so a later turn could retrieve it
    // without ever having been given it.
    for (const [i, sent] of sentPerTurn.entries()) {
      for (const earlier of messages.slice(0, i)) {
        expect(sent.includes(JSON.stringify(earlier).slice(1, -1)),
          `turn ${String(i + 1)} was not handed "${earlier.slice(0, 40)}": a turn sent only its own prompt is a one-turn `
          + 'conversation, which is the defect this suite exists to catch')
          .toBe(true);
      }
    }

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

    const hits = (callsPerTurn[3] ?? []).filter((call) =>
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

    const count = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM conversation_entries').get()?.c ?? 0;
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
    // The session's own evolution, on as the product runs it, says what it did as `evolution` events.
    const events = (agent?.events ?? []).flatMap((event) => (event.type === 'evolution' ? [event] : []));
    console.log(`  Events: ${events.length}`);

    for (const e of events) console.log(`    [${e.event}] ${e.message.slice(0, 70)}`);
    expect(events.length).toBeGreaterThan(0);
  });

  liveTest('memory has content', async () => {
    // Turn 3's note is written through the memory tool; nothing else writes MEMORY.md.
    const mem = await rt.memory.read('memory/MEMORY.md');

    if (!mem) throw new Error('the memory note turn 3 asked for was never written');
    console.log(`  Memory: ${mem.length} chars`);
  });

  liveTest('persistence', async () => {
    const msgsBefore = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM conversation_entries').get()?.c ?? 0;
    // The session ends as `kinu` ends one, before its store closes.
    await agent?.end();
    agent = undefined;
    db.close();
    const db2 = workspaceDatabase(DB_PATH);
    const msgsAfter = db2.query<{ c: number }, []>('SELECT COUNT(*) as c FROM conversation_entries').get()?.c ?? 0;
    const reopened = await openWorkspaceCLI(db2, DB_PATH, { llm: LLM_CONFIG, cwd: localTargetFolder(TEST_DIR) });
    const soul = reopened.info.soul;
    db2.close();
    expect(msgsAfter).toBe(msgsBefore);
    expect(soul).toContain('TypeScript');
    db = workspaceDatabase(DB_PATH);
  });
});
