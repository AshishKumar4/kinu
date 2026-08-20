/**
 * The research eval: does the agent RESEARCH — reach into a controlled source,
 * extract what is actually there, and report it — rather than complete from
 * priors?
 *
 * THE INSTRUMENT IS A CONTROLLED CORPUS (fixtures/veldmar-corpus.ts): a
 * fictional topic whose facts exist only in an archive this suite serves to the
 * agent over MCP. Fictional, so a correct answer cannot be memory; planted
 * non-round numbers, so extraction is exact-match checkable; a canary token that
 * exists in one provenance entry, so "the source was READ" is a fact the answer
 * either carries or does not. Scoring is string and number equality against the
 * corpus module — no LLM judge, no rubric, no opinion.
 *
 * WHY MCP AND NOT WORKSPACE FILES OR A WEB FIXTURE. The owner's design names
 * MCP as the channel, and the plumbing is real product surface with no live
 * coverage anywhere: `LocalAgentSession.connectMcp` is the same
 * `connectMcpServers` path a user's configured servers take — child process,
 * discovery, `mcp_<server>_<tool>` keying, result clamp, turn-surface merge —
 * and until this file nothing ever put a model behind it. Workspace files would
 * exercise the file tool instead, and a web-fetch fixture would test a stub of
 * the network rather than any shipped path.
 *
 * WHY THE ANSWER IS A STRUCTURED SELF-REPORT. The prompt asks for
 * `{status: "OK", ...}` and the suite PARSES it; it never greps prose. A reply
 * that refuses the shape is recorded and failed as its own finding — "the agent
 * cannot follow a reply contract" — rather than retried or fished out of a
 * sentence.
 *
 * EVERY VERDICT IS COMPUTED BEFORE ANY ASSERTION THROWS, and the observation is
 * pushed first: a failed retrieval must still reach the run record with what it
 * did retrieve, or the record only ever accumulates successes.
 *
 * THE DESIGNED RED: delete the canary from `ENTRIES` and the credential-free
 * integrity test fails naming it before anything is spent, and a live run fails
 * on `audit_token`. Measured 2026-08-19 (see docs/TESTING.md).
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';

import { initWorkspaceSchema, type LLMProviderConfig } from '../../packages/core/src/index';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { LocalAgentSession } from '../../packages/cli-backend/src/local-session';
import { connectMcpServers } from '../../packages/cli-backend/src/mcp';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeSql, makeWorkspaceSchemaSql } from '../../packages/cli-backend/src/runtime';
import {
  readLedgerTotals, requireExecutorSurface, requireSandboxedExecutors,
} from './harness';
import {
  assembleRunRecord, EVAL_MODELS, formatRunRecord, FULL_TOOL_SURFACE, liveChatModel,
  liveModelTarget, recordLiveModelEpisode, reportLiveModelSpend, subgoalOutcome, outcomeRow,
  UNCONFIGURED_LLM, writeRunRecord,
  type EvalArmState, type EvalObservation, type EvalScoreRow, type EvalTier,
} from '@proteus/test-utils';
import { resolveArtifactRoot } from '../../scripts/bench-retention';
import { CANARY, ENTRIES, PLANTED, RESEARCH_PROMPT, RESEARCH_TASK_ID } from './fixtures/veldmar-corpus';

const SUITE = 'Research Evals';
const TARGET = liveModelTarget(SUITE);
const liveTest = test.skipIf(!TARGET);

const REPO_ROOT = join(import.meta.dirname, '../..');
const SERVER_PATH = join(import.meta.dirname, 'fixtures/veldmar-mcp-server.ts');
/** The config key is what the tool keys derive from (`mcpToolKey`), so these two
 *  spellings and the server entry below must agree — they are named once here. */
const SERVER_NAME = 'veldmar';
const SEARCH_TOOL = `mcp_${SERVER_NAME}_archive_search`;
const READ_TOOL = `mcp_${SERVER_NAME}_archive_read`;

const TIER: EvalTier = process.env.PROTEUS_EVAL_TIER === 'pro' ? 'pro' : 'flash';
const LLM: LLMProviderConfig = TARGET === null
  ? UNCONFIGURED_LLM
  : { ...TARGET.llm, model: EVAL_MODELS[TIER] };

/** Evolution off: this family measures retrieval against a controlled source,
 *  and the behaviour arm owns the evolution comparison. The MCP tools are part
 *  of the surface actually offered, so they are recorded beside the builtins. */
const ARM: EvalArmState = {
  evolution: false,
  settle: 'none',
  tools: [...FULL_TOOL_SURFACE, SEARCH_TOOL, READ_TOOL],
};

/** Retained beside the record, never under a swept root — the same
 *  `resolveArtifactRoot` rule the behaviour arm states at length. */
const TRANSCRIPTS = join(
  resolveArtifactRoot({
    flag: undefined, env: { BENCH_ARTIFACTS: process.env.BENCH_ARTIFACTS },
    repoRoot: REPO_ROOT, runRoot: tmpdir(),
  }),
  `research-${TIER}-${String(Date.now())}`,
);

const opened: Database[] = [];
const observations: EvalObservation[] = [];

/** The reply contract, exactly as the prompt states it. `looseObject` because a
 *  model may add fields, and extra fields are not a refusal — a missing or
 *  mistyped required one is. */
const OkAnswerSchema = v.looseObject({
  status: v.literal('OK'),
  households_relocated: v.number(),
  deepest_sounding_m: v.number(),
  bell_tower_height_m: v.number(),
  audit_token: v.string(),
});
type OkAnswer = v.InferOutput<typeof OkAnswerSchema>;

/** The numeric fields scored against PLANTED. `satisfies` holds every name to
 *  the corpus; the integrity test holds the SET equal to PLANTED's keys, so a
 *  fourth planted fact cannot be silently unscored. */
const PLANTED_FIELDS = [
  'households_relocated', 'deepest_sounding_m', 'bell_tower_height_m',
] as const satisfies readonly (keyof typeof PLANTED)[];

/**
 * The newest assistant message that parses to the reply contract.
 *
 * Newest FIRST because `oneShot` arms the completion gate, whose confirming
 * turn may close after the answer — the report scored is the latest one the
 * agent stood behind. Fenced and bare JSON are both accepted: the contract is
 * the OBJECT, and a model that fences it has not refused the shape.
 */
function latestContractAnswer(db: Database): { answer: OkAnswer } | { refusal: string } {
  const sql = makeSql(db);
  const rows = sql<{ content: string }>`
    SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at DESC, rowid DESC`;
  if (rows.length === 0) return { refusal: 'the episode persisted no assistant message at all' };
  for (const row of rows) {
    for (const candidate of jsonCandidates(row.content)) {
      const parsed = v.safeParse(OkAnswerSchema, candidate);
      if (parsed.success) return { answer: parsed.output };
    }
  }
  return {
    refusal: `no assistant message carried the {"status":"OK",...} reply shape over `
      + `${String(rows.length)} message(s) — the agent did not follow the reply contract, `
      + 'which is the finding, not a parsing accident',
  };
}

/** Every parseable JSON object in one message: the whole text, then each fenced
 *  block, then the outermost brace span. */
function jsonCandidates(text: string): unknown[] {
  const raw: string[] = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const fenced = match[1];
    if (fenced !== undefined) raw.push(fenced.trim());
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) raw.push(text.slice(first, last + 1));
  const parsed: unknown[] = [];
  for (const candidate of raw) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch (error) {
      // Non-JSON text is the tolerated case — the next candidate may parse, and
      // the contract check above reports a message that never yields one.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return parsed;
}

afterAll(() => {
  const spend = reportLiveModelSpend(SUITE);
  const record = assembleRunRecord({
    family: 'research', tier: TIER, modelId: LLM.model, repeats: 1, seed: 1,
    arm: ARM, declaredTasks: [RESEARCH_TASK_ID], observations, spend,
    transcripts: TRANSCRIPTS, repoRoot: REPO_ROOT,
  });
  const out = process.env.PROTEUS_EVAL_RECORD ?? join(TRANSCRIPTS, 'run-record.json');
  writeRunRecord(out, record);
  console.log(`\n${formatRunRecord(record)}\n\nrecord: ${out}\n`);
  for (const db of opened) db.close();
});

describe('Research evals — a live retrieval from a controlled MCP source', () => {
  /**
   * CREDENTIAL-FREE, and the eval's own ground truth: the corpus is only a
   * control if the answers live in the archive and nowhere in the prompt. A
   * prompt that leaks a planted value is an eval a model passes without reading
   * anything, and a corpus that lost its canary can no longer prove reading —
   * both must fail here, by name, before anything is spent.
   */
  test('the corpus is controlled: facts in the archive, none of them in the prompt', () => {
    const served = ENTRIES.map((entry) => `${entry.title}\n${entry.body}`).join('\n\n');

    const canaryCarriers = ENTRIES.filter((entry) => entry.body.includes(CANARY));
    expect(canaryCarriers.length,
      `the canary ${CANARY} must live in exactly one archive entry — in ${String(canaryCarriers.length)}, `
      + 'the eval cannot prove the source was read').toBe(1);

    for (const [field, value] of Object.entries(PLANTED)) {
      expect(served.includes(String(value)),
        `planted ${field}=${String(value)} is not in the served text — the agent could never read it`)
        .toBe(true);
      expect(RESEARCH_PROMPT.includes(String(value)),
        `planted ${field}=${String(value)} LEAKED into the prompt — the eval would pass without the source`)
        .toBe(false);
    }
    expect([...PLANTED_FIELDS].sort(),
      'the scored field list and the planted corpus diverged — a planted fact nobody scores is dead '
      + 'weight, and a scored field nobody plants can never pass')
      .toEqual(Object.keys(PLANTED).sort());
    expect(RESEARCH_PROMPT.includes(CANARY),
      `the canary ${CANARY} LEAKED into the prompt — presence in an answer would prove nothing`)
      .toBe(false);
  });

  /**
   * CREDENTIAL-FREE: the fixture speaks MCP through the product's own client —
   * the same `connectMcpServers` the live episode's session uses. Without this,
   * "the agent never called the archive" and "the archive never came up" are the
   * same live red; with it, a broken fixture fails here for nothing.
   */
  test('the archive comes up through the product MCP client and both tools answer', async () => {
    const conn = await connectMcpServers({
      [SERVER_NAME]: { command: 'bun', args: [SERVER_PATH] },
    });
    try {
      const failed = conn.diagnostics.filter((d) => d.status === 'failed');
      expect(failed, `MCP server(s) failed to start: ${JSON.stringify(failed)}`).toEqual([]);
      expect(Object.keys(conn.tools).sort()).toEqual([READ_TOOL, SEARCH_TOOL].sort());

      const call = async (name: string, args: Record<string, string>): Promise<string> => {
        const entry = conn.tools[name];
        if (!entry?.execute) throw new Error(`${name} was discovered but carries no execute`);
        const result: unknown = await entry.execute(args, { toolCallId: 'research-eval', messages: [] });
        return String(result);
      };
      // The search names the provenance entry, the read serves the canary: the
      // exact two hops the live episode is scored on.
      expect(await call(SEARCH_TOOL, { query: 'audit token provenance' })).toContain('archive-provenance');
      expect(await call(READ_TOOL, { id: 'archive-provenance' })).toContain(CANARY);
    } finally {
      await conn.close();
    }
  });

  liveTest('MEASURED: the agent reads the archive and its report carries the planted facts and the canary', async () => {
    mkdirSync(TRANSCRIPTS, { recursive: true });
    const dbPath = join(TRANSCRIPTS, 'agent.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    opened.push(db);

    // Birth, then OPEN — the two steps production takes, for the reason
    // harness.ts states at length: the birth runtime registers no executors.
    await createWorkspace(db, {
      name: 'research-eval',
      purpose: 'A careful researcher who reads sources before reporting and never invents a figure.',
      llm: LLM,
    });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: LLM, hostRoot: null });
    requireExecutorSurface(RESEARCH_TASK_ID, rt);
    requireSandboxedExecutors(RESEARCH_TASK_ID, rt);

    const session = new LocalAgentSession({
      rt, db, model: liveChatModel(LLM), onEvent: () => {},
      noAutoEvolve: !ARM.evolution, oneShot: true,
    });

    const startedAt = Date.now();
    try {
      await session.connectMcp({ [SERVER_NAME]: { command: 'bun', args: [SERVER_PATH] } });
      // BEFORE the model is driven, so a fixture that missed its startup budget
      // costs nothing: the archive's tools are on this session's surface.
      const surface = session.describeTools().map((tool) => tool.name);
      expect(surface, 'the archive tools never reached the turn surface — nothing to research with')
        .toEqual(expect.arrayContaining([SEARCH_TOOL, READ_TOOL]));

      await session.send(RESEARCH_PROMPT);
      await session.settleBackgroundWork();
    } catch (error) {
      observations.push({
        taskId: RESEARCH_TASK_ID, repetition: 0, outcome: 'errored',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // Kills the archive child process; the workspace db stays open for the
      // record and is closed in afterAll.
      await session.end();
    }
    const ms = Date.now() - startedAt;

    // What the episode COST, before any verdict can throw: a failed retrieval
    // still burned what it burned.
    recordLiveModelEpisode(makeSql(db));
    const totals = readLedgerTotals(db);
    const sourceCalls = totals.toolNames.filter((name) => name.startsWith(`mcp_${SERVER_NAME}_`));

    // EVERY verdict, computed before ANY assertion throws.
    const parsed = latestContractAnswer(db);
    const fieldVerdicts = PLANTED_FIELDS.map((field) => ({
      field,
      expected: PLANTED[field],
      reported: 'answer' in parsed ? parsed.answer[field] : undefined,
    }));
    const fieldsRight = fieldVerdicts.filter((verdict) => verdict.reported === verdict.expected).length;
    const canaryRight = 'answer' in parsed && parsed.answer.audit_token === CANARY;
    const reached = fieldsRight + (canaryRight ? 1 : 0);
    const total = fieldVerdicts.length + 1;

    const detail = 'answer' in parsed
      ? fieldVerdicts
        .map((verdict) => `${verdict.field}: reported ${String(verdict.reported)}, planted ${String(verdict.expected)}`)
        .join('; ')
        + `; audit_token: ${canaryRight ? 'verbatim' : `WRONG — ${JSON.stringify(parsed.answer.audit_token)} is not the planted ${CANARY}`}`
      : parsed.refusal;

    const scores: EvalScoreRow[] = [
      outcomeRow(subgoalOutcome(reached, total, detail)),
      {
        name: 'controlled_source_use',
        asserts: 'the episode called the controlled MCP archive at least once — the one channel '
          + 'the planted facts exist behind',
        eligible: 1,
        passed: sourceCalls.length > 0 ? 1 : 0,
        rate: sourceCalls.length > 0 ? 1 : 0,
        detail: `${String(sourceCalls.length)} archive call(s) of ${String(totals.toolCalls)} tool calls`,
        measured: { archiveCalls: sourceCalls.length, toolCalls: totals.toolCalls },
      },
    ];
    // The observation FIRST, so a failed retrieval still reaches the record
    // with what it did retrieve.
    observations.push({
      taskId: RESEARCH_TASK_ID, repetition: 0, outcome: 'scored',
      scores, turns: totals.turns, toolCalls: totals.toolCalls, toolNames: totals.toolNames,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, ms,
    });
    console.log(`    ${String(totals.turns)} turn(s), ${String(totals.toolCalls)} tool call(s) `
      + `(${String(sourceCalls.length)} to the archive), ${String(totals.steps)} step(s), `
      + `${(ms / 1000).toFixed(1)}s, ${String(totals.tokensIn)} in / ${String(totals.tokensOut)} out tokens`);
    console.log(`    verdict: ${detail}`);

    // ── Denominators first ─────────────────────────────────────────────────
    expect(totals.turns, 'the episode closed no turn — nothing ran').toBeGreaterThan(0);
    expect(sourceCalls.length,
      'the agent never called the controlled archive — whatever the answer says, it was not research'
      + (totals.failures.length > 0 ? ` (recorded failures: ${totals.failures.join(' | ')})` : ''))
      .toBeGreaterThan(0);

    // ── The reply contract was followed ────────────────────────────────────
    if ('refusal' in parsed) throw new Error(parsed.refusal);

    // ── The report carries the archive, not an invention ───────────────────
    for (const verdict of fieldVerdicts) {
      expect(verdict.reported,
        `${verdict.field}: the answer says ${String(verdict.reported)} but the archive plants `
        + `${String(verdict.expected)} — a figure that is not the source's is a fabricated one`)
        .toBe(verdict.expected);
    }
    expect(parsed.answer.audit_token,
      `the canary ${CANARY} is missing from the answer: without it the run cannot prove the `
      + 'provenance entry was read rather than the numbers guessed')
      .toBe(CANARY);
  });
});
