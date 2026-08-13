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
import type { LanguageModel } from 'ai';
import {
  HeadController, HeadJournal, MissionGovernor, createWorkspace,
  initSearchTables, initScaffoldTables, initCraftScoreTables,
  type LLMProviderConfig, type MergeResult, type WebSearchProvider,
} from '../packages/core/src/index.js';
import { createCLIHeadRuntime } from '../packages/cli-backend/src/head-runtime.js';
import { createCLIRuntime, makeSql } from '../packages/cli-backend/src/runtime.js';
import { resolveChatModel } from '../packages/cli-backend/src/local-session.js';

interface PanelWorkerInput {
  dbPath: string;
  workspaceName: string;
  purpose: string;
  /** The one task every member of the panel is given. */
  ask: string;
  /** One entry per fork. Identical entries are the `self` arm; one per vendor
   *  family is the `mixed` arm. Length is the panel size. */
  panel: LLMProviderConfig[];
  /** The parent/analyst config — the model that writes the merge. Held constant
   *  across arms on purpose: this experiment varies the PANEL, not the analyst,
   *  and letting both move would make a difference unattributable. */
  analyst: LLMProviderConfig;
  maxTokens: number;
}

interface PanelWorkerOutput {
  tokens: number;
  steps: number;
  hadError: boolean;
  budgetBreach: 'tokens' | null;
  peakPromptTokens: number;
  /** Secondary metric: the grounded [0,1] outcome the heads path already
   *  computes per fork (execution-banded when the fork left runnable code).
   *  The PRIMARY metric is the sandbox's own checks, scored by the harness. */
  headScores: number[];
  grounded: boolean;
  blindSpots: string[];
  error?: string;
}

/** Meters what a panel actually spends. Every member and the analyst are wrapped
 *  by the same counter, so the cost reported for an arm is the whole panel's. */
function meteredModel(base: LanguageModel, onUsage: (tokens: number) => void): LanguageModel {
  const inner = base as unknown as { doGenerate: (o: unknown) => Promise<{ usage?: unknown }> };
  const bound = inner.doGenerate.bind(inner);
  return {
    ...(base as object),
    doGenerate: async (options: unknown) => {
      const result = await bound(options);
      const u = result.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      onUsage((u?.inputTokens ?? 0) + (u?.outputTokens ?? 0));
      return result;
    },
  } as unknown as LanguageModel;
}

/** The spec a fork carries is its INDEX into the panel list, not a registry
 *  name: the bench talks to explicit provider configs rather than a credential
 *  store, and an index cannot accidentally resolve to an operator's own model. */
const forkSpec = (i: number): string => `panel-${i}`;

async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as PanelWorkerInput;

  const fresh = !existsSync(input.dbPath);
  if (fresh) mkdirSync(dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  if (fresh) {
    await createWorkspace(db as never, {
      name: input.workspaceName, purpose: input.purpose, llm: input.analyst,
    });
    initSearchTables((ddl: string) => db.exec(ddl));
    initScaffoldTables((ddl: string) => db.exec(ddl));
    initCraftScoreTables((ddl: string) => db.exec(ddl));
  }

  let tokens = 0;
  let breach: 'tokens' | null = null;
  const meter = (spent: number): void => {
    tokens += spent;
    if (tokens > input.maxTokens && !breach) breach = 'tokens';
  };
  const modelFor = (cfg: LLMProviderConfig): LanguageModel =>
    meteredModel(resolveChatModel(cfg), meter);

  const rt = createCLIRuntime(db as never, { dbPath: input.dbPath, llm: input.analyst });
  const governor = new MissionGovernor({ storage: rt.storage });
  const byIndex = new Map(input.panel.map((cfg, i) => [forkSpec(i), cfg]));

  // A panel member does no live research — every arm must see the same world,
  // and a flaky search result is variance charged to whichever arm drew it.
  const noWeb: WebSearchProvider = {
    search: async () => ({ query: '', results: [], source: 'disabled' as never }),
    fetch: async () => ({ url: '', title: '', markdown: '', retrievedAt: '' }),
  };

  const headRuntime = createCLIHeadRuntime({
    model: modelFor(input.analyst),
    parentRuntime: rt,
    cwd: process.cwd(),
    resolveModel: (spec: string) => {
      const cfg = byIndex.get(spec);
      if (!cfg) throw new Error(`panel worker: no provider for fork spec "${spec}"`);
      return modelFor(cfg);
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
  }

  const out: PanelWorkerOutput = {
    tokens,
    steps: merge?.costSummary.headCount ?? 0,
    hadError: error !== undefined,
    budgetBreach: breach,
    peakPromptTokens: 0,
    headScores: merge ? merge.headScores.map((s) => s.score) : [],
    grounded: merge?.grounded ?? false,
    blindSpots: merge ? [...merge.blindSpots] : [],
    ...(error ? { error } : {}),
  };
  db.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch((err) => {
  const out: PanelWorkerOutput = {
    tokens: 0, steps: 0, hadError: true, budgetBreach: null, peakPromptTokens: 0,
    headScores: [], grounded: false, blindSpots: [],
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(1);
});
