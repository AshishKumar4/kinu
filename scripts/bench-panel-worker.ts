#!/usr/bin/env bun
// One fork PANEL against a bench sandbox, in its own process.
//
// This is the measurement instrument for a single question: does a fork panel
// do better work when its members are different models than when they are
// copies of one? Mixture-of-Agents (arXiv 2406.04692) says diversity helps;
// Self-MoA (arXiv 2502.00674) says it hurts, because panel quality tracks the
// panel's AVERAGE member rather than its spread, so a weaker model added for
// variety subtracts. Both were scored by LLM judges on open-ended prompts.
// Here the score is the repository's own test suite and typecheck, run over
// whatever the panel actually left on disk — which is the thing neither paper
// had and the reason the answer may differ for agentic coding work.
//
// The design is a literal MoA replication, so the ONLY difference between the
// arms is which model each member runs:
//   • every fork gets the IDENTICAL task (the defect prompt), because a panel
//     is repeated attempts at one problem, not a decomposition of it. Varying
//     the decomposition would confound the treatment with how the work split.
//   • `self`  — every fork runs the same provider config. Today's real default:
//     forks inherit the parent model unless the agent names one.
//   • `mixed` — fork i runs panel provider i, one per vendor family.
// Both arms take the same code path; only the config list differs.
//
// No chat session drives this. The panel IS the treatment, and a conversational
// wrapper around it would add a turn of model variance to every attempt for
// nothing. The heads run against process.cwd(), which the harness sets to the
// attempt's throwaway sandbox, so what they leave on disk is what gets scored.
//
// stdout carries exactly one JSON line (the result); everything else is stderr.
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  HeadController, HeadJournal, MissionGovernor,
  initSearchTables, initScaffoldTables, initCraftScoreTables,
  type LLMProviderConfig, type MergeResult, type WebSearchProvider,
} from '../packages/core/src/index.js';
import { createWorkspace } from '../packages/core/src/identity/index.js';
import { createCLIHeadRuntime } from '../packages/cli-backend/src/head-runtime.js';
import { createCLIRuntime, makeSql } from '../packages/cli-backend/src/runtime.js';
import { resolveChatModel } from '../packages/cli-backend/src/local-session.js';
import { createBenchInferenceProxy } from './bench-inference-proxy.js';
import { parsePanelWorkerInput, type WorkerOutput } from './bench-worker-protocol.js';

/** The spec a fork carries is its INDEX into the panel list, not a registry
 *  name: the bench talks to explicit provider configs rather than a credential
 *  store, and an index cannot accidentally resolve to an operator's own model. */
const forkSpec = (i: number): string => `panel-${i}`;

async function main(): Promise<void> {
  const input = parsePanelWorkerInput(await Bun.stdin.text());
  const proxy = createBenchInferenceProxy({
    upstreamBaseURL: input.analyst.baseURL,
    additionalUpstreamBaseURLs: input.panel.map((config) => config.baseURL),
    maxTokens: input.maxTokens,
  });
  const throughProxy = (config: LLMProviderConfig): LLMProviderConfig => ({
    ...config,
    baseURL: proxy.baseURLFor(config.baseURL),
  });
  const analyst = throughProxy(input.analyst);
  const panel = input.panel.map(throughProxy);

  const fresh = !existsSync(input.dbPath);
  if (fresh) mkdirSync(dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath);
  // SAFETY: The CLI backend owns this bun:sqlite adapter boundary; the same Database instance is its production input.
  const backendDb = db as never;
  db.exec('PRAGMA journal_mode = WAL');
  if (fresh) {
    await createWorkspace(backendDb, {
      name: input.workspaceName, purpose: input.purpose, llm: analyst,
    });
    initSearchTables((ddl: string) => db.exec(ddl));
    initScaffoldTables((ddl: string) => db.exec(ddl));
    initCraftScoreTables((ddl: string) => db.exec(ddl));
  }

  const rt = createCLIRuntime(backendDb, { dbPath: input.dbPath, llm: analyst });
  const governor = new MissionGovernor({ storage: rt.storage });
  const byIndex = new Map(panel.map((config, index) => [forkSpec(index), config]));

  // A panel member does no live research — every arm must see the same world,
  // and a flaky search result is variance charged to whichever arm drew it.
  const noWeb: WebSearchProvider = {
    search: async () => ({ query: '', results: [], source: 'duckduckgo' }),
    fetch: async () => ({ url: '', title: '', markdown: '', retrievedAt: '' }),
  };

  const headRuntime = createCLIHeadRuntime({
    model: resolveChatModel(analyst),
    parentRuntime: rt,
    cwd: process.cwd(),
    resolveModel: (spec: string) => {
      const cfg = byIndex.get(spec);
      if (!cfg) throw new Error(`panel worker: no provider for fork spec "${spec}"`);
      return resolveChatModel(cfg);
    },
    webSearch: noWeb,
    codemodeExtras: () => [],
    governor: () => governor,
    // The execution-grounded evaluator the MCTS engine uses, so each fork's
    // outcome is a real number and the merge is the median of k samples.
    grounding: { executor: rt.executor, explorer: rt.llm },
  });

  let error: string | undefined;
  let merge: MergeResult | null = null;
  try {
    merge = await new HeadController(headRuntime, new HeadJournal(makeSql(db))).run({
      parentHeadId: null,
      mode: 'build',
      inheritedContext: [],
      request: {
        rationale: input.ask,
        // Identical task per fork — the MoA setup. `model` is what the arm varies.
        heads: input.panel.map((_, i) => ({
          task: input.ask,
          rationale: `Panel member ${i + 1} of ${input.panel.length}, attempting the task independently.`,
          model: forkSpec(i),
        })),
        mergeStrategy: 'synthesize',
      },
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await proxy.settle();
    db.close();
    proxy.stop(true);
  }

  const usage = proxy.usage();
  if (usage.unmeteredResponses > 0) {
    const usageError = `${usage.unmeteredResponses} successful inference response(s) omitted token usage`;
    error = error ? `${error}; ${usageError}` : usageError;
  }

  const out: WorkerOutput = {
    tokens: usage.tokens,
    steps: merge?.costSummary.headCount ?? 0,
    hadError: error !== undefined,
    budgetBreach: usage.tokens > input.maxTokens ? 'tokens' : null,
    peakPromptTokens: usage.peakPromptTokens,
    modelCalls: usage.calls,
    /** Secondary metric: the grounded outcome the heads path computes per fork.
     *  The primary metric is still the sandbox's own checks in the harness. */
    headScores: merge ? merge.headScores.map((s) => s.score) : [],
    grounded: merge?.grounded ?? false,
    blindSpots: merge ? [...merge.blindSpots] : [],
  };
  if (error) out.error = error;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((err) => {
  const out: WorkerOutput = {
    tokens: 0, steps: 0, hadError: true, budgetBreach: null, peakPromptTokens: 0,
    modelCalls: 0,
    headScores: [], grounded: false, blindSpots: [],
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(1);
});
