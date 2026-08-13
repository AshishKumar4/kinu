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
import type { LanguageModel } from 'ai';
import {
  createWorkspace, initSearchTables, initScaffoldTables, initCraftScoreTables, usageTokens,
  type LLMProviderConfig,
} from '../packages/core/src/index.js';
import { openWorkspaceCLI, resolveChatModel, LocalAgentSession } from '../packages/cli-backend/src/index.js';
import type { SessionEvent } from '../packages/cli-backend/src/index.js';

interface WorkerInput {
  dbPath: string;
  workspaceName: string;
  purpose: string;
  /** Sent in order on ONE session. A defect task sends one. */
  asks: string[];
  /** Parallel to `asks`: a path relative to the sandbox that is removed once
   *  that ask has been answered, or null. This is what makes a continuation
   *  task measure continuation — the materials an early episode read are gone
   *  before the final ask, so only what survived can answer it. */
  removeAfterAsk: Array<string | null>;
  maxTokens: number;
  autoEvolve: boolean;
  /** Provider config, passed explicitly so no ambient PROTEUS_* can reach a
   *  scored run. */
  llm: LLMProviderConfig;
  sessionId: string;
}

interface WorkerOutput {
  tokens: number;
  steps: number;
  hadError: boolean;
  budgetBreach: 'tokens' | null;
  /** Largest per-turn prompt size the provider actually priced, over the whole
   *  ask sequence. The context-discipline number: a variant can spend the same
   *  total tokens with a much smaller working set. */
  peakPromptTokens: number;
  error?: string;
}

/** Wraps the chat model to count what the turn actually spends. The AI SDK
 *  reports usage on the stream's `finish` part; nothing else in the local stack
 *  aggregates it, and an unmetered attempt makes the budget a fiction. */
function meteredModel(base: LanguageModel, onUsage: (tokens: number) => void): LanguageModel {
  const inner = base as unknown as { doStream: (o: unknown) => Promise<{ stream: ReadableStream }> };
  const bound = inner.doStream.bind(inner);
  return {
    ...(base as object),
    doStream: async (options: unknown) => {
      const result = await bound(options);
      const counting = new TransformStream({
        transform(chunk: { type?: string; usage?: unknown }, controller) {
          if (chunk?.type === 'finish') onUsage(usageTokens(chunk.usage));
          controller.enqueue(chunk);
        },
      });
      return { ...result, stream: result.stream.pipeThrough(counting) };
    },
  } as unknown as LanguageModel;
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  const input = JSON.parse(raw) as WorkerInput;

  const fresh = !existsSync(input.dbPath);
  if (fresh) mkdirSync(dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  if (fresh) {
    // A v0 workspace: bootstrap scaffold, empty memory, empty CraftStore, no
    // lessons. This is the "stateless" arm's starting point, and it is one call.
    await createWorkspace(db as never, { name: input.workspaceName, purpose: input.purpose, llm: input.llm });
    initSearchTables((ddl: string) => db.exec(ddl));
    initScaffoldTables((ddl: string) => db.exec(ddl));
    initCraftScoreTables((ddl: string) => db.exec(ddl));
  }

  const { rt } = await openWorkspaceCLI(db as never, input.dbPath, { llm: input.llm });

  let tokens = 0;
  let breach: 'tokens' | null = null;
  let steps = 0;
  let hadError = false;

  const model = meteredModel(resolveChatModel(input.llm), (spent) => {
    tokens += spent;
    if (tokens > input.maxTokens && !breach) {
      breach = 'tokens';
      session.interrupt();
    }
  });

  const session = new LocalAgentSession({
    rt,
    db: db as never,
    model,
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

  // The provider-priced prompt size the compaction ladder measured for the
  // last turn. Read after each ask and maxed, because the row is overwritten
  // every turn and the peak is what a context-discipline change moves.
  const readPromptTokens = (): number => {
    const row = db.query('SELECT MAX(last_prompt_tokens) AS peak FROM compaction_state').get() as { peak: number | null } | null;
    return row?.peak ?? 0;
  };

  let error: string | undefined;
  let peakPromptTokens = 0;
  try {
    for (const [index, ask] of input.asks.entries()) {
      await session.send(ask);
      peakPromptTokens = Math.max(peakPromptTokens, readPromptTokens());
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
    db.close();
  }

  const out: WorkerOutput = {
    tokens, steps, hadError, budgetBreach: breach, peakPromptTokens,
    ...(error ? { error } : {}),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((err) => {
  const out: WorkerOutput = {
    tokens: 0, steps: 0, hadError: true, budgetBreach: null, peakPromptTokens: 0,
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(1);
});
