#!/usr/bin/env bun
// One Proteus session, in its own process — one ask for a defect task, a whole
// episode sequence for a long-horizon continuation task.
//
// A subprocess is not incidental here — it is what makes the isolation real.
// The local shell and laptop executor root themselves at process.cwd(), and
// PROTEUS_HOME is read once at module load, so an in-process driver would run
// every attempt against the harness's own cwd and home. Spawned with cwd set to
// the sandbox and PROTEUS_HOME set to the attempt's throwaway home, both are
// correct by construction.
//
// stdout carries exactly one JSON line (the result); everything else goes to
// stderr so a noisy agent cannot corrupt the measurement.
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  initSearchTables, initScaffoldTables, initCraftScoreTables,
} from '../packages/core/src/index.js';
import { createWorkspace } from '../packages/core/src/identity/index.js';
import { openWorkspaceCLI, resolveChatModel, LocalAgentSession } from '../packages/cli-backend/src/index.js';
import type { SessionEvent } from '../packages/cli-backend/src/index.js';
import { createBenchInferenceProxy } from './bench-inference-proxy.js';
import { parseAgentWorkerInput, type WorkerOutput } from './bench-worker-protocol.js';

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const input = parseAgentWorkerInput(raw);

  let session: LocalAgentSession | undefined;
  const proxy = createBenchInferenceProxy({
    upstreamBaseURL: input.llm.baseURL,
    maxTokens: input.maxTokens,
    onBreach: () => { session?.interrupt(); },
  });
  const meteredLLM = { ...input.llm, baseURL: proxy.baseURL };

  const fresh = !existsSync(input.dbPath);
  if (fresh) mkdirSync(dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath);
  // SAFETY: The CLI backend owns this bun:sqlite adapter boundary; the same Database instance is its production input.
  const backendDb = db as never;
  db.exec('PRAGMA journal_mode = WAL');
  if (fresh) {
    // A v0 workspace: bootstrap scaffold, empty memory, empty CraftStore, no
    // lessons. This is the "stateless" arm's starting point, and it is one call.
    await createWorkspace(backendDb, { name: input.workspaceName, purpose: input.purpose, llm: meteredLLM });
    initSearchTables((ddl: string) => db.exec(ddl));
    initScaffoldTables((ddl: string) => db.exec(ddl));
    initCraftScoreTables((ddl: string) => db.exec(ddl));
  }

  const { rt } = await openWorkspaceCLI(backendDb, input.dbPath, { llm: meteredLLM });

  let steps = 0;
  let hadError = false;

  session = new LocalAgentSession({
    rt,
    db: backendDb,
    model: resolveChatModel(meteredLLM),
    onEvent: (event: SessionEvent) => {
      if (event.type === 'turn-end') {
        steps = event.turn.steps;
        hadError = event.turn.hadError;
      } else if (event.type === 'error') {
        hadError = true;
        process.stderr.write(`[worker] ${event.message}\n`);
      }
    },
    noAutoEvolve: !input.autoEvolve,
    sessionId: input.sessionId,
    cwd: process.cwd(),
  });

  let error: string | undefined;
  try {
    for (const [index, ask] of input.asks.entries()) {
      await session.send(ask);
      await proxy.settle();
      const remove = input.removeAfterAsk[index];
      if (remove) rmSync(join(process.cwd(), remove), { recursive: true, force: true });
      // Fold at every episode boundary, so a continuation task genuinely
      // crosses compaction rather than depending on the corpus happening to
      // trip the measured trigger.
      if (index < input.asks.length - 1) session.armForcedCompaction();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    hadError = true;
  } finally {
    await session.end().catch(() => {});
    await proxy.settle();
    db.close();
    proxy.stop(true);
  }

  const usage = proxy.usage();
  if (usage.unmeteredResponses > 0) {
    const usageError = `${usage.unmeteredResponses} successful inference response(s) omitted token usage`;
    error = error ? `${error}; ${usageError}` : usageError;
    hadError = true;
  }

  const out: WorkerOutput = {
    tokens: usage.tokens,
    steps,
    hadError,
    budgetBreach: usage.tokens > input.maxTokens ? 'tokens' : null,
    peakPromptTokens: usage.peakPromptTokens,
    modelCalls: usage.calls,
  };
  if (error) out.error = error;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((err) => {
  const out: WorkerOutput = {
    tokens: 0, steps: 0, hadError: true, budgetBreach: null, peakPromptTokens: 0,
    modelCalls: 0,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(1);
});
