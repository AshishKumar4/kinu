// createCLIHeadRuntime — the local HeadRuntime backing the `think` tool's heads
// strategy. The cf backend runs heads as ExplorationAgent Facets; locally each
// head runs IN-PROCESS over its own ephemeral SqliteFS + virtual shell (an
// isolated :memory: DB — siblings can't see each other's PRIVATE sandbox),
// driven by the SAME core head loop (runHeadInference) the Facet uses. Heads are
// LLM-bound, so the HeadController's Promise.all gives real concurrency without
// subprocesses; the merge LLM runs in this process.
//
// Full head surface (parity with the cf Facet): record_evidence/record_decision
// (core) + private sandbox_* (per-head ephemeral VFS) + shared_* (the COMMON
// agent VFS at shared/findings/<headId>/, visible to siblings + the main agent)
// + split_subheads (recursive nested HeadController, depth-budgeted).

import { generateText, tool, jsonSchema, type LanguageModel, type ToolSet } from 'ai';
import {
  type HeadRuntime, type HeadGrounding, type SpawnedHead, type HeadInput, type HeadReport, type MergeOutput,
  type MergeStrategy, type VFS, type WebSearchProvider,
  HeadCapture, runHeadInference, buildHeadAccumulatorTools, buildHeadSandboxTools,
  buildHeadWebTools, HeadController, HeadJournal, initHeadsTables, budgetExhausted, extractJsonObject,
  reasoningEffortOptions,
} from '@proteus/core';
import { Database } from 'bun:sqlite';
import { SqliteFS } from '@proteus/agent-utils/vfs';
import { createShell } from '@proteus/agent-utils/shell';
import { makeSql, makeExecRaw } from './runtime.js';

export interface CLIHeadRuntimeDeps {
  model: LanguageModel;
  /** Provider prefix from the normalized model spec. */
  providerFamily?: string;
  /** The main agent's VFS — backs the shared findings scratch (shared/findings/).
   *  All heads of a split share it (in-process), so siblings + the agent see
   *  each other's shared writes. Omit ⇒ shared_* tools are not offered. */
  sharedVfs?: VFS;
  /** The shared web research provider — same seam the main loop uses. Omit ⇒
   *  web_search / web_fetch are not offered to heads. */
  webSearch?: WebSearchProvider;
  /** Execution-grounding seam — the same executor + judge the MCTS engine uses,
   *  so head outcomes + the merge are grounded, not heuristic. Omit ⇒ neutral
   *  scores + n=1 merge. */
  grounding?: HeadGrounding;
}

/** Per-head abort flag — flipped by SpawnedHead.abort (wall-clock timeout). */
interface AbortFlag { aborted: boolean; reason: string | null; }

const SHARED_ROOT = 'shared/findings';

export function createCLIHeadRuntime(deps: CLIHeadRuntimeDeps): HeadRuntime {
  return {
    async spawnHead(input: HeadInput): Promise<SpawnedHead> {
      const flag: AbortFlag = { aborted: false, reason: null };
      return {
        id: input.id,
        run: () => runLocalHead(input, deps, flag),
        async abort(reason: string) { flag.aborted = true; flag.reason = reason; },
      };
    },
    mergeLLM: (prompt) => mergeViaLLM(deps.model, prompt, deps.providerFamily),
    ...(deps.grounding ? { grounding: deps.grounding } : {}),
  };
}

/** Run one head in-process over an isolated ephemeral SqliteFS sandbox. */
async function runLocalHead(input: HeadInput, deps: CLIHeadRuntimeDeps, flag: AbortFlag): Promise<HeadReport> {
  const db = new Database(':memory:');
  try {
    const sqliteFs = new SqliteFS(makeSql(db) as never);
    sqliteFs.init();
    const shell = createShell(sqliteFs);
    const capture = new HeadCapture();
    const tools = filterByAllowed({
      ...buildHeadAccumulatorTools(capture),
      ...buildHeadSandboxTools(shell, sqliteFs, capture),
      ...(deps.webSearch ? buildHeadWebTools(deps.webSearch, capture) : {}),
      ...(deps.sharedVfs ? buildSharedScratchTools(deps.sharedVfs, input.id, capture) : {}),
      ...buildSplitSubheadsTool(input, deps, capture),
    }, input.allowedTools);
    return await runHeadInference(input, {
      model: deps.model, tools, capture,
      isAborted: () => flag.aborted,
      abortReason: () => flag.reason,
    });
  } finally {
    db.close();
  }
}

/** shared_write/read/list over the agent's common VFS, head-namespaced under
 *  shared/findings/<headId>/ so siblings can't clobber each other. */
function buildSharedScratchTools(vfs: VFS, headId: string, capture: HeadCapture): ToolSet {
  return {
    shared_write: tool({
      description:
        'Write a finding to the SHARED agent-level scratch (visible to sibling heads AND the main agent at `shared/findings/`). Use for results worth sharing across heads — your sandbox_* files stay private. Your writes are head-namespaced so siblings can\'t clobber them.',
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object', required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      }),
      execute: async ({ path, content }) => {
        const full = `${SHARED_ROOT}/${headId}/${path.replace(/^\/+/, '')}`;
        try {
          await vfs.writeFile(full, content);
          capture.recordArtifact({ kind: 'file', ref: full, description: `shared finding (${content.length}b)` });
          capture.recordToolCall('shared_write', { path, contentLen: content.length }, 'ok');
          return `wrote shared finding → ${full}`;
        } catch (err) {
          capture.recordToolCall('shared_write', { path }, 'error');
          return `shared write error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    shared_read: tool({
      description: 'Read a finding from the shared agent-level scratch (path relative to `shared/findings/`, e.g. another head\'s `<headId>/notes.md`). Use shared_list to discover paths.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object', required: ['path'], properties: { path: { type: 'string' } },
      }),
      execute: async ({ path }) => {
        const full = `${SHARED_ROOT}/${path.replace(/^\/+/, '')}`;
        try {
          const c = await vfs.readFile(full, { encoding: 'utf8' });
          capture.recordToolCall('shared_read', { path }, 'ok');
          return typeof c === 'string' ? c : new TextDecoder().decode(c);
        } catch {
          capture.recordToolCall('shared_read', { path }, 'missing');
          return `(no shared finding at ${path})`;
        }
      },
    }),
    shared_list: tool({
      description: 'List all findings currently in the shared agent-level scratch (paths relative to `shared/findings/`, across every head).',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async () => {
        try {
          const paths = await walkFiles(vfs, SHARED_ROOT);
          capture.recordToolCall('shared_list', {}, `${paths.length} files`);
          return paths.length ? paths.join('\n') : '(shared scratch is empty)';
        } catch (err) {
          capture.recordToolCall('shared_list', {}, 'error');
          return `shared list error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

/** split_subheads — a head spawns 2-4 child heads recursively (depth-budgeted),
 *  their findings merged into one narrative. In-process: a nested HeadController
 *  over a fresh CLI head runtime sharing the same model + shared scratch. */
function buildSplitSubheadsTool(input: HeadInput, deps: CLIHeadRuntimeDeps, capture: HeadCapture): ToolSet {
  return {
    split_subheads: tool({
      description:
        'Spawn 2-4 child heads recursively to explore narrower sub-questions. ' +
        'Children\'s findings merge into a single narrative. May fail if depth exhausted.',
      inputSchema: jsonSchema<{ rationale: string; heads: Array<{ task: string; rationale: string }>; merge_strategy?: MergeStrategy }>({
        type: 'object', required: ['rationale', 'heads'],
        properties: {
          rationale: { type: 'string' },
          heads: {
            type: 'array', minItems: 2, maxItems: 4,
            items: {
              type: 'object', required: ['task', 'rationale'],
              properties: { task: { type: 'string' }, rationale: { type: 'string' } },
            },
          },
          merge_strategy: { type: 'string', enum: ['synthesize', 'best_of', 'consensus'] },
        },
      }),
      execute: async ({ rationale, heads, merge_strategy }): Promise<string> => {
        // budgetExhausted covers max-depth, tokens and wall-clock in one gate.
        const exh = budgetExhausted(input.budget, capture.tokenUsage.input + capture.tokenUsage.output);
        if (exh.exhausted) return `Cannot split: budget exhausted (${exh.reason}).`;
        const db = new Database(':memory:');
        try {
          initHeadsTables(makeExecRaw(db));
          const controller = new HeadController(createCLIHeadRuntime(deps), new HeadJournal(makeSql(db)));
          const result = await controller.run({
            parentHeadId: input.id,
            rootId: input.rootId,
            inheritedContext: input.inheritedContext,
            request: { rationale, heads, mergeStrategy: merge_strategy ?? input.mergeStrategy },
            parentBudget: input.budget,
            model: input.model,
          });
          for (const cid of result.headIds) capture.childHeadIds.push(cid);
          capture.recordToolCall('split_subheads', { rationale, heads }, `merged ${result.costSummary.headCount}`);
          const lines: string[] = [result.mergedNarrative];
          if (result.selectedDecisions.length) {
            lines.push('', "Children's selected decisions:");
            for (const d of result.selectedDecisions) lines.push(`- ${d.question}: ${d.choice}`);
          }
          if (result.unresolvedQuestions.length) {
            lines.push('', 'Open questions:');
            for (const q of result.unresolvedQuestions) lines.push(`- ${q}`);
          }
          return lines.join('\n');
        } catch (err) {
          capture.recordToolCall('split_subheads', { rationale, heads }, 'error');
          return `split_subheads failed: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          db.close();
        }
      },
    }),
  };
}

/** Recursively list file paths under `dir` (relative to `dir`). */
async function walkFiles(vfs: VFS, dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: string[];
    try { entries = await vfs.readdir(d); } catch { return; }
    for (const e of entries) {
      const full = `${d}/${e}`;
      const st = await vfs.stat(full);
      if (st?.isDir) await walk(full);
      else out.push(full.slice(dir.length + 1));
    }
  };
  await walk(dir);
  return out;
}

/** Restrict a head's toolset to its allowedTools (undefined = all). */
function filterByAllowed(tools: ToolSet, allowed: readonly string[] | undefined): ToolSet {
  if (allowed === undefined) return tools;
  const set = new Set(allowed);
  return Object.fromEntries(Object.entries(tools).filter(([name]) => set.has(name)));
}

/** The merge synthesis call — return parsed JSON; the HeadController validates it
 *  against MergeOutputSchema and falls back on a bad/throwing response. */
async function mergeViaLLM(model: LanguageModel, prompt: string, providerFamily?: string): Promise<MergeOutput> {
  const providerOptions = reasoningEffortOptions('low', providerFamily ?? '');
  const { text } = await generateText({
    model,
    prompt,
    ...(providerOptions ? { providerOptions } : {}),
  });
  return extractJsonObject(text) as MergeOutput;
}
