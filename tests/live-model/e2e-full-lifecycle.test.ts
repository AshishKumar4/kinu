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
import * as v from 'valibot';

import {
  
  createFactsStore,
  extractJsonObject,
  openWorkspaceMainActor,
  type JsonObject,
  type LLMProviderConfig,
} from '../../packages/core/src/index';
import { tolerate } from '../../packages/core/src/obs';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeSql, soulIn, type CLIRuntime } from '../../packages/cli-backend/src/runtime';
import { evalSession, scriptedEvalModel, type EvalSession } from './harness';
import { localTargetFolder, provisionLocalTarget } from './target-local';
import { finalIntegerAnswer,
liveModelTarget, recordLiveModelEpisode, reportLiveModelSpend,
UNCONFIGURED_LLM, workspaceDatabase,
} from '@kinu.run/test-utils';

// Proof against a real model, so a target is required. `liveModelTarget` states
// which target and cost basis this run used, or why it is skipping — and throws
// on a half-configured environment rather than skipping green.
const TARGET = liveModelTarget('E2E Full Lifecycle');

const liveTest = test.skipIf(!TARGET);

const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;

const TEST_DIR = join(tmpdir(), 'kinu-e2e-full-' + Date.now());

const DB_PATH = join(TEST_DIR, 'agent.db');

/** Durability of an opaque value, not the model's capitalization or surrounding prose. */
const MEMORY_CODE = 'lifecycle-amber-9c7d2';

/**
 * WHERE the fact actually landed, across both memory write surfaces.
 *
 * `memory` offers two legitimate ways to store one: `note` appends to
 * `memory/MEMORY.md`, `remember` upserts a keyed row in `agent_facts`
 * (core/src/operations/memory.ts). A prompt that says "save this fact"
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
/** A tool call's `op` argument as a name to print; `?` when the call carried none, which is how a tool with no
 *  operations reads. */
function opName(args: JsonObject): string {
  const op = v.safeParse(v.string(), args.op);

  return op.success ? op.output : '?';
}

function storedMemoryFact(db: Database, memoryFile: string | null): string | null {
  if (memoryFile?.includes(MEMORY_CODE)) return 'memory/MEMORY.md';
  // The workspace is reopened from disk here, so the actor whose facts these
  // are has to be named the way an operator names it: the workspace's MAIN
  // actor, issued through the production directory. That is the actor the
  // session above drove.
  const sql = makeSql(db);

  const fact = createFactsStore(sql, openWorkspaceMainActor(sql)).all()
    .find((row) => JSON.stringify(row.value).includes(MEMORY_CODE));

  return fact ? `agent_facts[${fact.key}]` : null;
}

// ── Tests ────────────────────────────────────────────────────────

describe('E2E Full Lifecycle', () => {
  let db: InstanceType<typeof Database>;
  let rt: CLIRuntime;
  let agentId: string;
  let agentName: string;
  /** The product's own session over the workspace, made by the first live turn. */
  let agent: EvalSession | undefined;

  const live = (): EvalSession => {
    agent ??= evalSession({ rt, db, llm: LLM_CONFIG });

    return agent;
  };

  beforeAll(async () => {
    // Provisioned through the seam: birth, the whole schema, open, the executor-surface and sandbox guards and the
    // pre-turn profile, the same sequence every live suite drives, once. `db` and `rt` stay reassignable because step
    // 6 closes and reopens the store; afterAll therefore still closes whichever handle is live.
    const target = await provisionLocalTarget({
      dir: TEST_DIR,
      workspace: 'lifecycle-test',
      purpose: 'A coding assistant that helps write and test JavaScript code.',
      llm: LLM_CONFIG,
    });

    db = target.db;
    rt = target.runtime;
    agentId = rt.identity.id;
    agentName = rt.identity.name;
  });

  afterAll(async () => {
    await agent?.end();

    if (agent !== undefined) recordLiveModelEpisode(rt.storage.sql, rt.actor);
    reportLiveModelSpend('E2E Full Lifecycle');
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Step 1: Verify creation ──────────────────────────────────

  test('1. agent created with its SOUL.md and identity', async () => {
    const soul = soulIn(rt.space) ?? '';
    expect(soul).toContain('JavaScript');

    const identity = db.query<{ id: string; name: string }, []>(
      'SELECT id, name FROM workspace_identity LIMIT 1',
    ).get();

    if (!identity) throw new Error('workspace identity row was not created');
    expect(identity.id).toBeTruthy();
    expect(identity.name).toBe('lifecycle-test');

    console.log(`  Identity: ${identity.id} (${identity.name})`);
    console.log(`  Soul: ${soul.slice(0, 60)}`);
  });

  // ── Step 2: Verify tools ─────────────────────────────────────

  // Credential-free: the session's own `eval` runs a program a scripted model sends, in a workspace of its own.
  test('2. the session\'s tool surface executes', async () => {
    const own = await provisionLocalTarget({
      dir: `${TEST_DIR}-scripted`, workspace: 'lifecycle-scripted', purpose: 'A coding assistant.', llm: LLM_CONFIG,
    });

    const scripted = evalSession({ rt: own.runtime, db: own.db, model: scriptedEvalModel([{ call: 'eval', input: { code: 'return 6 * 7;' } }, { text: 'done' }]) });

    try {
      const { calls } = await scripted.turn('Work out six times seven with eval.');

      // Structural: the dispatcher answers `{result}`, the shape every live suite reads.
      expect(calls.map((call) => ({ name: call.name, result: call.result }))).toEqual([{ name: 'eval', result: { result: 42 } }]);
    } finally {
      await scripted.end();
      own.teardown();
    }
  });

  // ── Step 3: Chat turn 1 — simple, no tools ──────────────────

  liveTest('3. chat turn 1: simple math question', async () => {
    const { text, calls } = await live().turn('What is 2+2? Answer briefly.');
    console.log(`  Response (${text.length} chars): ${text.slice(0, 120)}`);
    console.log(`  Tools: ${calls.map((call) => call.name).join(', ') || 'none'}`);
    // The extracted integer, not a substring: any '4' anywhere in the reply
    // would satisfy `toContain`, including one from the question's echo.
    expect(finalIntegerAnswer(text)).toBe(4);
  }, 120_000);

  // ── Step 4: Chat turn 2 — should use eval ──────────

  liveTest('4. chat turn 2: code execution', async () => {
    const { text, calls } = await live().turn(
      'Use eval to write and run a JS prime checker for 7, 10, and 13. '
        + 'Print the results as one JSON object mapping each input to a boolean. '
        + 'Summarize which inputs are prime, then end your answer with their total count as a standalone integer.',
    );

    console.log(`  Response (${text.length} chars): ${text.slice(0, 200)}`);
    console.log(`  Tools: ${calls.map((call) => call.name).join(', ') || 'none'}`);

    const executions = calls.filter((call) => call.name === 'eval');
    expect(executions.length, 'the model did not use eval').toBeGreaterThan(0);

    // What its programs said, printed or returned: the subject is that the code ran, not which of the two it used.
    const said = executions.flatMap((call) => {
      const output = v.parse(v.object({ result: v.optional(v.unknown()), logs: v.optional(v.array(v.string())) }), call.result);

      return [...output.logs ?? [], JSON.stringify(output.result ?? null)];
    });

    expect(said.map((line) => tolerate(() => extractJsonObject(line), 'malformed-input')))
      .toContainEqual({ 7: true, 10: false, 13: true });
    expect(finalIntegerAnswer(text)).toBe(2);
  }, 300_000);

  // ── Step 5: Chat turn 3 — persist a memory note ───────────────

  liveTest('5. chat turn 3: save note to memory', async () => {
    const { text, calls } = await live().turn(
      `The project's recovery identifier is ${MEMORY_CODE}. Use the memory tool to save it for a later conversation.`,
    );

    console.log(`  Response (${text.length} chars): ${text.slice(0, 200)}`);
    console.log(`  Tools: ${calls.map((call) => call.name).join(', ') || 'none'}`);

    const wrote = calls.find((call) => call.name === 'memory' && (call.args.op === 'note' || call.args.op === 'remember'));

    expect(wrote, 'the model never wrote through the memory tool — it called '
      + (calls.map((call) => `${call.name}.${opName(call.args)}`).join(', ')
        || 'nothing'))
      .toBeDefined();
    const where = storedMemoryFact(db, await rt.memory.read('memory/MEMORY.md'));
    expect(where, 'the memory tool reported a write but neither memory/MEMORY.md nor agent_facts '
      + 'holds the fact, so nothing was persisted for step 6 to find')
      .not.toBeNull();
    console.log(`  Stored via memory.${wrote === undefined ? '?' : opName(wrote.args)} in ${String(where)}`);
  }, 120_000);

  // ── Step 6: Close and reopen with openWorkspaceCLI ──────────────────

  liveTest('6. close and reopen agent — verify persistence', async () => {
    // The session ends as `kinu` ends one, before its store closes; its spend is read while the store is open.
    await agent?.end();
    recordLiveModelEpisode(rt.storage.sql, rt.actor);
    agent = undefined;
    db.close();

    const db2 = workspaceDatabase(DB_PATH);
    const { rt: rt2, info } = await openWorkspaceCLI(db2, DB_PATH, { llm: LLM_CONFIG, cwd: localTargetFolder(TEST_DIR) });
    // Hand over the reopened database and runtime before any assertion can
    // throw. Otherwise, an assertion failure leaves later steps holding the
    // closed database: step 7 reports unrelated `bun:sqlite` prepare errors,
    // making one cause appear as three failures.
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
    const msgCount = db2.query<{ c: number }, []>('SELECT COUNT(*) as c FROM conversation_entries').get()?.c ?? 0;
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
    console.log(`  Search nodes: ${info.searchNodeCount}`);
    console.log(`  Memory size: ${info.memorySize} bytes`);
    console.log(`  Messages: ${msgCount}`);
  });
});
