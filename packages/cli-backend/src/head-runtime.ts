// createCLIHeadRuntime — the local HeadRuntime backing the `think` tool's heads
// strategy. The cf backend runs heads as ExplorationAgent Facets; locally each
// head runs IN-PROCESS over its own ephemeral SqliteFS + virtual shell (an
// isolated :memory: DB — siblings can't see each other), driven by the SAME core
// head loop (runHeadInference) the Facet uses. Heads are LLM-bound, so the
// HeadController's Promise.all gives real concurrency without subprocesses.
//
// The merge LLM runs in this process (one call by the controller). Shared scratch
// + recursive split_subheads are deferred (the head still has record_evidence/
// record_decision + its private sandbox_*).

import { generateText, type LanguageModel, type ToolSet } from 'ai';
import {
  type HeadRuntime, type SpawnedHead, type HeadInput, type HeadReport, type HeadId, type MergeOutput,
  HeadCapture, runHeadInference, buildHeadAccumulatorTools, buildHeadSandboxTools,
} from '@proteus/core';
import { Database } from 'bun:sqlite';
import { SqliteFS } from '@proteus/agent-utils/vfs';
import { createShell } from '@proteus/agent-utils/shell';
import { makeSql } from './runtime.js';

/** Per-head abort flag — flipped by SpawnedHead.abort (wall-clock timeout). */
interface AbortFlag { aborted: boolean; reason: string | null; }

export function createCLIHeadRuntime(deps: { model: LanguageModel }): HeadRuntime {
  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const flag: AbortFlag = { aborted: false, reason: null };
      return {
        id: input.id,
        run: () => runLocalHead(input, deps.model, flag),
        async abort(reason: string) { flag.aborted = true; flag.reason = reason; },
      };
    },
    mergeLLM: (prompt) => mergeViaLLM(deps.model, prompt),
  };
}

/** Run one head in-process over an isolated ephemeral SqliteFS sandbox. */
async function runLocalHead(input: HeadInput, model: LanguageModel, flag: AbortFlag): Promise<HeadReport> {
  const db = new Database(':memory:');
  try {
    const sqliteFs = new SqliteFS(makeSql(db) as never);
    sqliteFs.init();
    const shell = createShell(sqliteFs);
    const capture = new HeadCapture();
    const tools = filterByAllowed({
      ...buildHeadAccumulatorTools(capture),
      ...buildHeadSandboxTools(shell, sqliteFs, capture),
    }, input.allowedTools);
    return await runHeadInference(input, {
      model, tools, capture,
      isAborted: () => flag.aborted,
      abortReason: () => flag.reason,
    });
  } finally {
    db.close();
  }
}

/** Restrict a head's toolset to its allowedTools (undefined = all). record_* +
 *  sandbox_* are the head's only surface here, so this mostly passes through. */
function filterByAllowed(tools: ToolSet, allowed: readonly string[] | undefined): ToolSet {
  if (allowed === undefined) return tools;
  const set = new Set(allowed);
  return Object.fromEntries(Object.entries(tools).filter(([name]) => set.has(name)));
}

/** The merge synthesis call — return parsed JSON; the HeadController validates it
 *  against MergeOutputSchema and falls back on a bad/throwing response. */
async function mergeViaLLM(model: LanguageModel, prompt: string): Promise<MergeOutput> {
  const { text } = await generateText({ model, prompt, maxOutputTokens: 4096 });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('merge LLM returned no JSON object');
  return JSON.parse(match[0]) as MergeOutput;
}
