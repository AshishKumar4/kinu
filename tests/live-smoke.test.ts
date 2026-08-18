/**
 * Live smoke: ONE real agent turn per backend, against the Workers-AI default.
 *
 * WHY THIS FILE EXISTS. Six suites cover the agent's behaviour against a real
 * model and every one of them skipped, so no gate had ever run the agentic loop
 * end to end. The first time the eval tier was given a credential it took
 * 6m23s to run `E2E Lifecycle` alone and found a suite that had been broken
 * since the `spawnBranch` guard landed. A tier whose cheapest member costs six
 * minutes is a tier people learn to skip, and rot accumulates behind it.
 *
 * So this is the floor: two turns, ~40 seconds, one per backend. It does not
 * replace the six — it is the part that must never be allowed to rot, because
 * everything else in the tier is downstream of "can the agent take a turn at
 * all". Each turn must reach the model, call a tool, and leave a DURABLE row
 * behind, because those are the three things a mocked test cannot prove and the
 * three things every richer suite assumes.
 *
 * WHY TWO BACKENDS AND NOT ONE. `packages/cli-backend/src/local-session.ts` and
 * `packages/cf-backend/src/{orchestrator,actor-agent}.ts` are 9,466 lines with no
 * shared turn implementation, so "the agent takes a turn" is TWO claims. The
 * hosted one runs inside the deployed Worker's Durable Object, reached over the
 * same ticket-authenticated websocket `proteus chat` uses; the local one runs
 * in-process through the same spine as `proteus exec`. Neither substitutes for
 * the other.
 *
 * COST. Both turns run on `@cf/deepseek-ai/deepseek-v4-pro-0813` through the
 * owner's Workers AI allocation, which his plan includes — the marginal USD cost
 * is zero and the billed unit is neurons. `mcts/cost.ts` cannot say that (one
 * blended per-token rate for every model), which is why nothing here asserts a
 * dollar figure.
 *
 * WHAT IT DOES NOT MEASURE, AND WHY THAT IS NOT PAPERED OVER. The cloud
 * websocket protocol carries no per-turn usage (`AgentTurnResult.usage` is
 * documented local-only), so the hosted turn's tokens are UNKNOWABLE from the
 * client. It is recorded as one call per step with usage unreported, which makes
 * the tier print `N call(s) … usage unreported` rather than a silent zero —
 * absent stays distinguishable from free.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { initWorkspaceSchema, type LLMProviderConfig } from '../packages/core/src/index';
import { createWorkspace } from '../packages/core/src/identity/index';
import { LocalAgentSession, type SessionEvent } from '../packages/cli-backend/src/local-session';
import { openWorkspaceCLI } from '../packages/cli-backend/src/open';
import { makeSql, makeWorkspaceSchemaSql } from '../packages/cli-backend/src/runtime';
import { createCloudAgent, deleteCloudAgent } from '../packages/cli/src/cloud-api';
import { CloudAgentClient } from '../packages/cli/src/cloud-agent-client';
import { requireSandboxedExecutors } from './evals/harness';
import {
  liveChatModel, liveModelTarget, recordLiveModelEpisode, recordLiveModelSpend,
  reportLiveModelSpend, scratchDir, UNCONFIGURED_LLM, type LiveModelSession,
} from '@proteus/test-utils';

const TARGET = liveModelTarget('Live Smoke');
const LLM_CONFIG: LLMProviderConfig = TARGET?.llm ?? UNCONFIGURED_LLM;
const liveTest = test.skipIf(!TARGET);

/**
 * The hosted arm needs a WORKER, not merely a model. An `AI_GATEWAY_*` pair
 * resolves a live target with no Proteus deployment behind it, and there is
 * nothing to drive a Durable Object turn on — so that arm states the difference
 * instead of failing as though the deployment were broken.
 */
const HOSTED = TARGET?.via === 'worker-proxy' ? TARGET : null;
if (TARGET && !HOSTED) {
  console.warn('[skip] Live Smoke (hosted) — the resolved target is an AI Gateway, which fronts a '
    + 'model but no Proteus deployment. Set PROTEUS_ORIGIN + PROTEUS_TOKEN to reach the worker.');
}
const hostedTest = test.skipIf(!HOSTED);

const TEST_DIR = scratchDir('live-smoke');

/**
 * One prompt, used by both arms, and every clause in it is load-bearing: the
 * write forces a tool call, the fixed content makes the tool's effect checkable
 * rather than inferred from prose, and the one-word reply keeps a chatty model
 * from spending a minute on commentary.
 */
const SMOKE_PROMPT = 'Use your file tool to write the exact text "live smoke ok" into a file '
  + 'named smoke.txt. Then reply with only the word DONE.';

/** Cloud agents this file created, so teardown removes them even on failure. */
const createdCloudAgents: string[] = [];

describe('Live Smoke — one real turn per backend', () => {
  afterAll(async () => {
    // Deleting BEFORE the spend report so a failed delete cannot hide the
    // numbers, and awaited so the account is not left holding a smoke agent.
    // The error is reported and the loop continues: one undeletable agent must
    // not strand the rest, and it must never pass unmentioned.
    if (HOSTED) {
      const { origin, token } = workerCredentials(HOSTED.llm);
      for (const name of createdCloudAgents) {
        try {
          await deleteCloudAgent(origin, token, name);
        } catch (err) {
          console.warn(`[live-smoke] cloud agent ${name} was NOT deleted and may still exist `
            + `on the account — delete it with \`proteus delete ${name}\`: ${String(err)}`);
        }
      }
    }
    reportLiveModelSpend('Live Smoke');
  });

  hostedTest('hosted backend: one real turn through the deployed worker', async () => {
    if (!HOSTED) throw new Error('unreachable: hostedTest runs only with a worker target');
    const { origin, token } = workerCredentials(HOSTED.llm);

    const name = `smoke${Math.random().toString(36).slice(2, 10)}`;
    const created = await createCloudAgent(origin, token, {
      name,
      displayName: 'Live Smoke',
      purpose: 'A smoke-test agent that proves one real hosted turn runs.',
      model: HOSTED.llm.model,
    });
    createdCloudAgents.push(created.name);

    const client = new CloudAgentClient({
      origin, token, agentName: created.name, cloudName: created.name, oneShot: true,
    });
    try {
      await client.connect();
      const startedAt = Date.now();
      const turn = await client.send(SMOKE_PROMPT);
      const elapsedMs = Date.now() - startedAt;

      // One call per model step, usage unreported — see the header. Recorded
      // before the assertions so a turn that fails an assertion still reports
      // what it spent getting there.
      for (let step = 0; step < turn.steps; step += 1) recordLiveModelSpend();

      console.log(`    hosted turn: ${String(elapsedMs)}ms, ${String(turn.steps)} step(s), `
        + `tools [${turn.toolCalls.map((c) => c.name).join(', ')}]`);

      expect(turn.hadError).toBe(false);
      expect(turn.steps).toBeGreaterThan(0);
      // The agentic loop reached a tool. A single-step answer means the model
      // replied from its own head and the tool surface was never exercised,
      // which is the failure this file is the floor against.
      expect(turn.toolCalls.length).toBeGreaterThan(0);
      expect(turn.text.trim().length).toBeGreaterThan(0);

      // THE DURABLE WRITE, read back from the DO rather than from this process:
      // `history()` is the Durable Object's own chat projection, so a turn that
      // streamed convincingly and persisted nothing fails here.
      const history = await client.history();
      expect(history.length).toBeGreaterThanOrEqual(2);
      expect(history.some((m) => m.role === 'assistant')).toBe(true);

      const status = await client.status();
      console.log(`    hosted durable: ${String(status.messageCount)} message(s) in the DO, `
        + `model ${status.model}`);
      expect(status.messageCount).toBeGreaterThanOrEqual(2);
    } finally {
      await client.close();
    }
  }, 300_000);

  liveTest('cli backend: one real turn through the local session spine', async () => {
    const dbPath = join(TEST_DIR, 'smoke.db');
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    let session: LocalAgentSession | null = null;
    try {
      // Birth, then OPEN, exactly as production does and as the sibling
      // delegation eval documents: `createWorkspace`'s runtime is the degraded
      // one whose `spawnBranch` throws by design, so a suite that skips
      // `openWorkspaceCLI` is not running the spine it claims to. `E2E
      // Lifecycle` skips it and fails on that guard the moment it is given a
      // credential.
      await createWorkspace(db, {
        name: 'live-smoke',
        purpose: 'A precise assistant that uses its tools rather than answering from memory.',
        llm: LLM_CONFIG,
      });
      initWorkspaceSchema(makeWorkspaceSchemaSql(db));
      // `hostRoot: null` for the reason tests/evals/harness.ts states at length:
      // an episode reaches every registered executor and the default `laptop`
      // plane is rooted at the repo this suite was launched from. Asserted
      // rather than trusted, immediately below.
      const { rt } = await openWorkspaceCLI(db, dbPath, { llm: LLM_CONFIG, hostRoot: null });
      requireSandboxedExecutors('live-smoke', rt);

      const toolNames: string[] = [];
      let errorMessage: string | null = null;
      session = new LocalAgentSession({
        rt, db, model: liveChatModel(LLM_CONFIG), noAutoEvolve: true, oneShot: true,
        onEvent: (event: SessionEvent) => {
          if (event.type === 'tool-call') toolNames.push(event.toolName);
          // The spine reports a failed turn as an event, not a rejection, so a
          // turn that errored would otherwise pass every assertion below.
          if (event.type === 'error') errorMessage = event.message;
        },
      });

      const startedAt = Date.now();
      await session.send(SMOKE_PROMPT);
      const elapsedMs = Date.now() - startedAt;

      console.log(`    cli turn: ${String(elapsedMs)}ms, tools [${toolNames.join(', ')}]`);

      expect(errorMessage).toBeNull();
      expect(toolNames.length).toBeGreaterThan(0);

      // THE DURABLE WRITE: the user turn and the assistant answer, in the
      // workspace's own SQLite.
      const messages = db.query<{ c: number }, []>('SELECT COUNT(*) as c FROM messages').get()?.c ?? 0;
      console.log(`    cli durable: ${String(messages)} message row(s)`);
      expect(messages).toBeGreaterThanOrEqual(2);
    } finally {
      // `proteus exec`'s own one-shot sequence, and it is not optional. The
      // session detaches durable fibers, and `end()` documents the hazard
      // exactly: closing the database out from under one aborts its settle write
      // mid-flight. Measured here before this existed — the suite printed
      // `{"event":"turn.processing_failed","code":"io","cause":"processing a
      // queued turn: Cannot use a closed database"}` on a turn bun had ALREADY
      // reported as passing, which is a green test corrupting its own store.
      if (session) {
        await session.settleBackgroundWork();
        await session.end();
        // After the drain, so a background step's tokens are in the total, and
        // only when a session existed: an episode that never started must not
        // read as one that could not be measured.
        recordLiveModelEpisode(makeSql(db));
      }
      db.close();
    }
  }, 300_000);
});

/**
 * The worker origin and bearer behind a resolved worker-proxy target.
 *
 * Recovered from the target rather than re-read from `process.env`, so this file
 * cannot reach a different deployment than the one `liveModelTarget` announced
 * and the tier's banner printed.
 */
function workerCredentials(llm: LLMProviderConfig): LiveModelSession {
  const origin = llm.baseURL.replace(/\/api\/user\/ai\/v1$/, '');
  if (origin === llm.baseURL) {
    throw new Error(`live smoke: ${llm.baseURL} is not a worker AI-proxy base URL, so no worker `
      + 'origin can be recovered from it');
  }
  const header = llm.headers['Authorization'];
  if (!header) throw new Error('live smoke: the resolved worker target carries no Authorization header');
  return { origin, token: header.replace(/^Bearer /, '') };
}
