// Backend-agnostic head inference loop — the divergent-reasoning-thread run that
// produces a HeadReport. Both backends drive this: the cf-backend's Facet head
// (ExplorationAgent.runAsHead) and the CLI's subprocess head-worker. Previously
// this loop lived only inside the cf Facet; hoisting it here keeps ONE tested
// implementation so a CLI head behaves identically to a DO head.
//
// The backend provides the model + a HeadCapture + its own scratch tools
// (sandbox/shared/recursive-split). This module owns the record_evidence /
// record_decision accumulator tools, the head system prompt + inherited-context
// messages, the generateText loop (with the abort/step/budget stop condition),
// and the HeadReport assembly (via the shared head-summary helpers).

import { generateText, tool, jsonSchema, type ToolSet, type LanguageModel } from 'ai';
import {
  type HeadInput, type HeadReport, type HeadId,
  type Evidence, type Decision, type ArtifactRef,
  budgetExhausted,
} from './types.js';
import type { ToolCallRecord } from '../evolution/types.js';
import type { Shell } from '../types/primitives.js';
import type { WebSearchProvider, WebSearchResponse } from '../web/index.js';
import { WebFetchError } from '../web/index.js';
import { nanoid } from '../utils/nanoid.js';
import { extractFinalText, extractHeadSteps, synthesizeHeadSummary } from './head-summary.js';

/** The VFS surface a head's private sandbox needs — narrowed to the `'utf8'`
 *  encoding literal so BOTH the cf SqliteFS and the core VFS satisfy it without
 *  an adapter (their readFile encoding params differ only in that literal). */
export interface HeadSandboxVfs {
  readFile(path: string, opts?: { encoding?: 'utf8' }): Promise<Uint8Array | string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

/** Hard ceiling on a head's reasoning steps (budget derives a tighter cap). */
export const MAX_HEAD_STEPS = 16;

/**
 * The mutable findings a head accumulates as it runs — evidence/decisions
 * (recorded via the accumulator tools), artifacts + tool calls (recorded by the
 * backend's scratch tools), child head ids (recursive split), and token usage.
 * runHeadInference reads it into the final HeadReport; the backend's tools mutate
 * the SAME instance, so there is one source of truth per head run.
 */
export class HeadCapture {
  readonly evidence: Evidence[] = [];
  readonly decisions: Decision[] = [];
  readonly artifacts: ArtifactRef[] = [];
  readonly toolCalls: ToolCallRecord[] = [];
  readonly childHeadIds: HeadId[] = [];
  readonly tokenUsage = { input: 0, output: 0 };

  recordEvidence(e: Evidence): void { this.evidence.push(e); }
  recordDecision(d: Decision): void { this.decisions.push(d); }
  recordArtifact(a: ArtifactRef): void { this.artifacts.push(a); }
  recordToolCall(name: string, args: Record<string, unknown>, result: string): void {
    this.toolCalls.push({ name, args, result });
  }
  addChildIds(ids: readonly HeadId[]): void { for (const id of ids) this.childHeadIds.push(id); }
}

/** The two accumulator tools every head has — record_evidence / record_decision,
 *  pushing into the shared HeadCapture. Backend scratch tools are merged on top. */
export function buildHeadAccumulatorTools(capture: HeadCapture): ToolSet {
  return {
    record_evidence: tool({
      description:
        "Record a piece of evidence you've gathered. Use this for facts you want surfaced in the merge synthesis.",
      inputSchema: jsonSchema<{ kind: Evidence['kind']; body: string; ref?: string; confidence?: number }>({
        type: 'object', required: ['kind', 'body'],
        properties: {
          kind: { type: 'string', enum: ['tool_output', 'fact', 'citation', 'artifact'] },
          body: { type: 'string' }, ref: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      }),
      execute: async ({ kind, body, ref, confidence }) => {
        const ev: Evidence = { id: `ev-${nanoid(6)}`, kind, body, ref, confidence };
        capture.recordEvidence(ev);
        capture.recordToolCall('record_evidence', { kind, body, ref, confidence }, 'ok');
        return `evidence recorded (id=${ev.id})`;
      },
    }),
    record_decision: tool({
      description: 'Record a decision the head considered.',
      inputSchema: jsonSchema<{ question: string; choice: string; rationale: string; supportingEvidence?: string[] }>({
        type: 'object', required: ['question', 'choice', 'rationale'],
        properties: {
          question: { type: 'string' }, choice: { type: 'string' }, rationale: { type: 'string' },
          supportingEvidence: { type: 'array', items: { type: 'string' } },
        },
      }),
      execute: async ({ question, choice, rationale, supportingEvidence }) => {
        const d: Decision = { question, choice, rationale, supportingEvidence };
        capture.recordDecision(d);
        capture.recordToolCall('record_decision', { question, choice, rationale }, 'ok');
        return 'decision recorded';
      },
    }),
  };
}

/** A head's private ephemeral sandbox — sandbox_exec/read/write/list over a Shell
 *  + VFS the backend owns (cf: a per-Facet SqliteFS; CLI: a per-head ephemeral
 *  runtime). Siblings can't see it. Writes record a file ArtifactRef. */
export function buildHeadSandboxTools(shell: Shell, vfs: HeadSandboxVfs, capture: HeadCapture): ToolSet {
  return {
    sandbox_exec: tool({
      description: "Run a shell command in this head's ephemeral sandbox.",
      inputSchema: jsonSchema<{ command: string }>({
        type: 'object', required: ['command'], properties: { command: { type: 'string' } },
      }),
      execute: async ({ command }) => {
        const r = await shell.exec(command);
        capture.recordToolCall('sandbox_exec', { command }, `exit=${r.exitCode}`);
        if (r.exitCode !== 0) return `Exit ${r.exitCode}${r.stderr ? ': ' + r.stderr : ''}`;
        return r.stdout || '(no output)';
      },
    }),
    sandbox_read: tool({
      description: "Read a file from this head's ephemeral sandbox.",
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object', required: ['path'], properties: { path: { type: 'string' } },
      }),
      execute: async ({ path }) => {
        try {
          const c = await vfs.readFile(path, { encoding: 'utf8' });
          capture.recordToolCall('sandbox_read', { path }, 'ok');
          return typeof c === 'string' ? c : new TextDecoder().decode(c);
        } catch (err) {
          capture.recordToolCall('sandbox_read', { path }, 'error');
          return `read error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    sandbox_write: tool({
      description: "Write content to a file in this head's ephemeral sandbox.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object', required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      }),
      execute: async ({ path, content }) => {
        try {
          const dir = path.split('/').slice(0, -1).join('/');
          if (dir) { try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ } }
          await vfs.writeFile(path, content);
          capture.recordArtifact({ kind: 'file', ref: path, description: `head-written (${content.length}b)` });
          capture.recordToolCall('sandbox_write', { path, contentLen: content.length }, 'ok');
          return `wrote ${content.length} bytes to ${path}`;
        } catch (err) {
          capture.recordToolCall('sandbox_write', { path }, 'error');
          return `write error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    sandbox_list: tool({
      description: "List directory contents in this head's ephemeral sandbox.",
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object', required: ['path'], properties: { path: { type: 'string' } },
      }),
      execute: async ({ path }) => {
        try {
          const names = await vfs.readdir(path);
          capture.recordToolCall('sandbox_list', { path }, 'ok');
          return names.join('\n');
        } catch (err) {
          capture.recordToolCall('sandbox_list', { path }, 'error');
          return `list error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

/** web_search / web_fetch over the shared WebSearchProvider seam — the same
 *  key-less-by-default discovery+retrieval surface the main loop gets, so a
 *  research head can actually gather live information instead of reasoning from
 *  clipped inherited context alone. Both backends thread their own provider
 *  (cf: env.AI markdown + Tavily auth; cli: node fetch) through here. */
export function buildHeadWebTools(provider: WebSearchProvider, capture: HeadCapture): ToolSet {
  return {
    web_search: tool({
      description:
        'Search the web for ranked results (title, url, snippet). Key-less by default; loop with web_fetch to read the promising URLs.',
      inputSchema: jsonSchema<{ query: string; limit?: number }>({
        type: 'object', required: ['query'],
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'Max results (default 5, max 20).' },
        },
      }),
      execute: async ({ query, limit }) => {
        try {
          const res = await provider.search(query, limit !== undefined ? { limit } : undefined);
          capture.recordToolCall('web_search', { query, limit }, `${res.results.length} results`);
          return formatHeadSearchResults(res);
        } catch (err) {
          capture.recordToolCall('web_search', { query, limit }, 'error');
          return headWebError(err);
        }
      },
    }),
    web_fetch: tool({
      description: 'Fetch one absolute http(s) URL as clean markdown. Use after web_search to read a result.',
      inputSchema: jsonSchema<{ url: string }>({
        type: 'object', required: ['url'], properties: { url: { type: 'string' } },
      }),
      execute: async ({ url }) => {
        try {
          const res = await provider.fetch(url);
          capture.recordToolCall('web_fetch', { url }, 'ok');
          capture.recordArtifact({ kind: 'note', ref: res.url, description: res.title ?? res.url });
          return `# ${res.title ?? res.url}\nSource: ${res.url}\nRetrieved: ${res.retrievedAt}\n\n${res.markdown}`;
        } catch (err) {
          capture.recordToolCall('web_fetch', { url }, 'error');
          return headWebError(err);
        }
      },
    }),
  };
}

/** Render search results model-ready — mirrors the main loop's web_search shape
 *  (ranked title + url + snippet, synthesized answer first when present). */
function formatHeadSearchResults(res: WebSearchResponse): string {
  if (res.results.length === 0) return `No web results for "${res.query}".`;
  const lines: string[] = [];
  if (res.answer) lines.push(`Answer: ${res.answer}`, '');
  for (const r of res.results) {
    const date = r.date ? ` (${r.date})` : '';
    lines.push(`${r.position}. ${r.title}${date}\n   ${r.url}\n   ${r.snippet}`);
  }
  lines.push('', `[${res.results.length} results via ${res.source}]`);
  return lines.join('\n');
}

/** Honest, model-actionable web failure string (heads return plain strings). */
function headWebError(err: unknown): string {
  if (err instanceof WebFetchError) {
    return err.retriable ? `web error (retriable): ${err.message}` : `web error: ${err.message}`;
  }
  return `web error: ${err instanceof Error ? err.message : String(err)}`;
}

/** The head's system prompt — task framing + the head conventions (record_*,
 *  private sandbox vs shared scratch, web research, recursive split, isolation). */
const HEAD_PROMPT_TOOL_NAMES = [
  'record_evidence',
  'record_decision',
  'sandbox_exec',
  'sandbox_read',
  'sandbox_write',
  'sandbox_list',
  'web_search',
  'web_fetch',
  'shared_write',
  'shared_read',
  'shared_list',
  'split_subheads',
] as const;

function hasHeadTool(tools: ReadonlySet<string>, ...names: readonly string[]): boolean {
  return names.some((name) => tools.has(name));
}

function renderHeadToolConventions(input: HeadInput, availableToolNames?: readonly string[]): string[] {
  const tools = new Set(availableToolNames ?? HEAD_PROMPT_TOOL_NAMES);
  const lines: string[] = ['Conventions:'];
  if (hasHeadTool(tools, 'record_evidence')) {
    lines.push('- record_evidence whenever you learn something worth surfacing in the merge.');
  }
  if (hasHeadTool(tools, 'record_decision')) {
    lines.push('- record_decision when you make a substantive choice the parent might want to reconcile.');
  }
  if (hasHeadTool(tools, 'sandbox_exec', 'sandbox_read', 'sandbox_write', 'sandbox_list')) {
    lines.push('- sandbox_exec / sandbox_read / sandbox_write / sandbox_list = YOUR PRIVATE scratch (siblings can\'t see it).');
  }
  if (hasHeadTool(tools, 'web_search', 'web_fetch')) {
    lines.push('- Loop web_search to gather, then web_fetch to read the promising results; record_evidence each finding worth surfacing.');
  }
  if (hasHeadTool(tools, 'shared_write', 'shared_read', 'shared_list')) {
    lines.push('- shared_write / shared_read / shared_list = the COMMON scratch (shared/findings/), visible to sibling heads and the main agent. Put results worth sharing here; your writes are head-namespaced so siblings can\'t clobber them.');
  }
  if (hasHeadTool(tools, 'split_subheads')) {
    lines.push('- split_subheads to recursively explore deeper if needed (depth-budgeted).');
  }
  lines.push(
    '- Final text response: 2-4 sentences summarizing what you found + recommending what should happen next.',
    '- Stay focused on YOUR task. Don\'t try to do sibling heads\' work.',
  );
  if (!hasHeadTool(tools, 'shared_write', 'shared_read', 'shared_list')) {
    lines.push('- If you need to share findings but no shared scratch tool exists, put the finding in your final response and record_evidence if available.');
  }
  if (!hasHeadTool(tools, 'sandbox_exec', 'sandbox_read', 'sandbox_write', 'sandbox_list')) {
    lines.push('- If no sandbox tools exist, reason from inherited context and available accumulator/shared tools only.');
  }
  if (!hasHeadTool(tools, 'split_subheads')) {
    lines.push('- Do not propose recursive subheads; split_subheads is not available in this run.');
  }
  return [
    ...lines,
    '',
    `You are ONE OF SEVERAL heads running concurrently against the same agent's resources. When you touch a SHARED MUTABLE resource, isolate yourself so you don't race a sibling: for any git repo, create your own worktree (\`git worktree add ../head-${input.id.slice(0, 8)} <branch>\`) before working; for shared files, write under your own head-namespaced path or use shared_write when available. Read-only inspection of shared resources is always fine.`,
  ];
}

export function buildHeadSystemPrompt(input: HeadInput, availableToolNames?: readonly string[]): string {
  return [
    `You are a "head" — one of several parallel reasoning threads in a self-evolving agent runtime.`,
    ``,
    `Your task: ${input.task}`,
    `Why you were spawned: ${input.rationale}`,
    `Merge strategy: ${input.mergeStrategy} (your work will be combined with sibling heads via this strategy).`,
    ``,
    ...renderHeadToolConventions(input, availableToolNames),
    ``,
    `Budget: depth ${input.budget.maxDepth}, ${input.budget.maxTokens} tokens, ${input.budget.maxWallClockMs}ms wall-clock.`,
  ].join('\n');
}

/** The head's opening message — the inherited conversation + its assigned task. */
export function buildHeadMessages(input: HeadInput): Array<{ role: 'user' | 'assistant'; content: string }> {
  const lines: string[] = ['Here is the conversation you inherit:', ''];
  for (const m of input.inheritedContext) {
    const trimmed = m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content;
    lines.push(`[${m.role}${m.toolName ? `/${m.toolName}` : ''}] ${trimmed}`);
  }
  lines.push('', `Now focus on your assigned task: ${input.task}`);
  return [{ role: 'user', content: lines.join('\n') }];
}

/** When a head produced no prose turn, synthesize a summary from what it recorded
 *  (decisions / evidence / tool calls) so the merge has substance. */
function headFallbackSummary(input: HeadInput, status: HeadReport['status'], capture: HeadCapture, abortReason: string | null): string {
  if (status !== 'completed') {
    return `Head ${input.id} ended with status=${status}${abortReason ? ` (${abortReason})` : ''}.`;
  }
  return synthesizeHeadSummary({ decisions: capture.decisions, evidence: capture.evidence, toolCalls: capture.toolCalls })
    ?? `Head ${input.id} completed without producing a textual summary.`;
}

export interface HeadInferenceDeps {
  /** The LanguageModel this head reasons with (per-head model override applied upstream). */
  model: LanguageModel;
  /** The head's FULL toolset — the accumulator tools (buildHeadAccumulatorTools)
   *  + the backend's scratch tools (sandbox/shared/split). The caller assembles
   *  (and may filter) it so each backend keeps control over its allowed surface. */
  tools: ToolSet;
  /** Shared findings accumulator — the tools mutate this same instance. */
  capture: HeadCapture;
  /** Polled in stopWhen + read for the final status. */
  isAborted: () => boolean;
  /** Abort reason, surfaced in errorMessage. */
  abortReason?: () => string | null;
}

/**
 * Run one head's inference loop and assemble its HeadReport. A multi-step
 * generateText run that stops on abort, the derived step cap, or budget
 * exhaustion; the final text (last text-bearing step) becomes the summary, with
 * a recorded-findings fallback. Never throws — failures become an `errored`
 * report (the controller treats a thrown run() as budget_exceeded anyway).
 */
export async function runHeadInference(input: HeadInput, deps: HeadInferenceDeps): Promise<HeadReport> {
  const { capture } = deps;
  const startedAt = Date.now();
  const maxSteps = Math.min(MAX_HEAD_STEPS, Math.max(1, Math.floor(input.budget.maxTokens / 1200)));

  const usageTotal = () => ({
    input: capture.tokenUsage.input,
    output: capture.tokenUsage.output,
    total: capture.tokenUsage.input + capture.tokenUsage.output,
  });

  try {
    const result = await generateText({
      model: deps.model,
      system: buildHeadSystemPrompt(input, Object.keys(deps.tools)),
      messages: buildHeadMessages(input),
      tools: deps.tools,
      // Accumulate usage as each step finishes — fires before stopWhen is
      // evaluated — so the token ceiling can gate the run mid-flight rather
      // than only being noticed once the whole loop is done (THINKING-AUDIT §4 #7).
      onStepFinish: (step) => {
        const u = (step as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
        if (u) {
          capture.tokenUsage.input += u.inputTokens ?? 0;
          capture.tokenUsage.output += u.outputTokens ?? 0;
        }
      },
      stopWhen: ({ steps }) => {
        if (deps.isAborted()) return true;
        if (steps.length >= maxSteps) return true;
        if (budgetExhausted(input.budget, usageTotal().total).exhausted) return true;
        return false;
      },
    });

    const status: HeadReport['status'] = deps.isAborted()
      ? 'aborted'
      : budgetExhausted(input.budget, usageTotal().total).exhausted ? 'budget_exceeded' : 'completed';
    const abortReason = deps.abortReason?.() ?? null;
    const summary = extractFinalText(result) || headFallbackSummary(input, status, capture, abortReason);

    return {
      id: input.id, status, summary,
      evidence: [...capture.evidence],
      decisions: [...capture.decisions],
      artifactRefs: [...capture.artifacts],
      childHeadIds: [...capture.childHeadIds],
      toolCalls: [...capture.toolCalls],
      steps: extractHeadSteps(result.steps),
      tokenUsage: usageTotal(),
      wallClockMs: Date.now() - startedAt,
      errorMessage: abortReason ?? undefined,
    };
  } catch (err) {
    return {
      id: input.id, status: 'errored',
      summary: `Head ${input.id} errored: ${err instanceof Error ? err.message : String(err)}`,
      evidence: [...capture.evidence],
      decisions: [...capture.decisions],
      artifactRefs: [...capture.artifacts],
      childHeadIds: [...capture.childHeadIds],
      toolCalls: [...capture.toolCalls],
      steps: [],
      tokenUsage: usageTotal(),
      wallClockMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
