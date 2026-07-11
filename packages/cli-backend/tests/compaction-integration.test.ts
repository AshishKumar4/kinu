/**
 * The default compaction path end-to-end over the REAL storage plane both
 * backends share: an overflowing history driven through runChat with the
 * better-compact extension wired exactly as LocalAgentSession (and the DO's
 * beforeTurn) wires it — real CompositeVFS over SqliteFS in agent.db, real
 * compaction_state rows, a real EphemeralContextLedger.
 *
 * Proves the four 2B guarantees:
 *  1. the transform rewrites the model-visible history (fewer tokens, tail
 *     protected byte-verbatim, citable reference message present);
 *  2. the raw transcript is written into the workspace VFS AND reads back
 *     through the agent's own file surface (workspace.readFile) — the
 *     lossless-recall round-trip;
 *  3. the plan persists durably and an identical next turn REPLAYS it
 *     byte-stably without re-summarizing;
 *  4. the ledger resets ONLY on 'planned' — before the weave — so the fresh
 *     block lands at the compacted tail, and a replay keeps it frozen.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel, ModelMessage } from 'ai';
import {
  EphemeralContextLedger,
  ExtensionHost,
  runChat,
  EPHEMERAL_CONTEXT_HEADER,
} from '@proteus/core';
import {
  createCompactionExtension,
  createCompactionStateStore,
  createVfsTranscriptStore,
  initCompactionStateTable,
  type CompactionOutcomeEvent,
  type Logger,
} from '@proteus/compaction';
import { createCLIRuntime } from '../src/runtime.js';

const SESSION = 'proteus-itest:default';
const silentLogger: Logger = { info() {}, debug() {}, warn() {}, error() {} };

/** One user→assistant→tool exchange with a fat tool output. */
function exchange(i: number, outputChars: number): ModelMessage[] {
  const id = `call_${i}`;
  return [
    { role: 'user', content: `Task ${i}: please run step ${i} of the plan.` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Running step ${i} now.` },
        { type: 'tool-call', toolCallId: id, toolName: 'run', input: { command: `step-${i}.sh` } },
      ],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: id, toolName: 'run',
        output: { type: 'text', value: `output-${i} ${'x'.repeat(outputChars)}` },
      }],
    },
  ];
}

function history(exchanges: number, outputChars: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < exchanges; i++) messages.push(...exchange(i, outputChars));
  return messages;
}

type PromptMessage = { role: string; content: Array<{ type: string; text?: string }> | string };

/** One-step text model that records the exact prompt of every call. */
function capturingModel(): { model: LanguageModel; prompts: PromptMessage[][] } {
  const prompts: PromptMessage[][] = [];
  const model = {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doStream: async (options: { prompt: PromptMessage[] }) => {
      prompts.push(options.prompt);
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't1' });
            c.enqueue({ type: 'text-delta', id: 't1', delta: 'ok' });
            c.enqueue({ type: 'text-end', id: 't1' });
            c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 9_000, outputTokens: 2, totalTokens: 9_002 } });
            c.close();
          },
        }),
        response: { headers: {} },
      };
    },
  } as unknown as LanguageModel;
  return { model, prompts };
}

function messageText(m: PromptMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
}

function ephemeralBlocks(prompt: PromptMessage[]): number[] {
  const indices: number[] = [];
  prompt.forEach((m, i) => {
    if (m.role === 'user' && messageText(m).startsWith(EPHEMERAL_CONTEXT_HEADER)) indices.push(i);
  });
  return indices;
}

describe('default compaction over the real storage plane', () => {
  test('rewrite → VFS transcript read-back → durable replay → ledger reset only on planned', async () => {
    const db = new Database(':memory:');
    const rt = createCLIRuntime(db as never, {
      dbPath: `/tmp/proteus-compaction-itest-${Math.floor(performance.now())}.db`,
      llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' },
    });

    initCompactionStateTable(rt.storage.execRaw);
    const state = createCompactionStateStore(rt.storage.sql);
    const ledger = new EphemeralContextLedger();
    const outcomes: CompactionOutcomeEvent[] = [];
    let summarizeCalls = 0;
    // Wired EXACTLY as both backends wire it: shared stores + model-transport
    // summarize + the planned-only ledger reset.
    const extension = createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => rt.storage.vfs),
        plans: state.plans,
        logger: silentLogger,
      },
      summarize: async () => {
        summarizeCalls++;
        return `Summary(${summarizeCalls}): completed the historical steps, recorded outcomes, decisions, and file paths for future reference in detail.`;
      },
      onOutcome: (event) => {
        outcomes.push(event);
        if (event.outcome === 'planned') ledger.reset();
      },
    });

    const { model, prompts } = capturingModel();
    const drive = async (messages: ModelMessage[]) => {
      for await (const _ of runChat({
        model,
        modelContext: { id: 'fake/fake-model', contextWindow: 10_000 },
        system: 'system prompt',
        history: messages,
        systemState: { ledger, context: { factsBlock: '- the user prefers TypeScript' } },
        tools: {},
        maxSteps: 1,
        extensions: new ExtensionHost().register(extension),
        cache: { sessionKey: SESSION },
      })) { /* drain */ }
    };

    // ── Turn 0: small history, no compaction — the ledger freezes one block.
    const small = history(2, 100);
    await drive(small);
    expect(outcomes).toHaveLength(0);
    expect(ledger.size).toBe(1);
    expect(ephemeralBlocks(prompts[0] ?? [])).toHaveLength(1);

    // ── Turn 1: overflowing history → a fresh plan rewrites the context.
    const overflowing = history(15, 3_000); // ~45k chars ≈ 11k tokens > 8.5k trigger
    await drive(overflowing);
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned']);

    const plannedPrompt = prompts[1] ?? [];
    const plannedJson = JSON.stringify(plannedPrompt);
    // Substantially fewer bytes on the wire than the raw history.
    expect(plannedJson.length).toBeLessThan(JSON.stringify(overflowing).length * 0.5);

    // The protected tail survives (tool results ride as tool-result parts,
    // so assert over the serialized prompt).
    expect(plannedJson).toContain('Task 14: please run step 14');
    expect(plannedJson).toContain('output-14 ');
    // Early fat tool output was pruned out of the model's view.
    expect(plannedJson).not.toContain('output-0 ');

    // The reference message cites the transcript path the plan persisted.
    const snapshot = state.plans.load(SESSION);
    if (!snapshot) throw new Error('expected a persisted plan snapshot');
    expect(snapshot.transcriptRelativePath.startsWith('/local/.proteus/compaction/')).toBe(true);
    expect(plannedJson).toContain(snapshot.transcriptRelativePath);

    // Durable persistence is a real row in agent.db, not memory.
    const rows = rt.storage.sql<{ plan_json: string }>`
      SELECT plan_json FROM compaction_state WHERE session_key = ${SESSION}`;
    expect(rows).toHaveLength(1);

    // ── Lossless recall: the citation reads back through the agent's own
    // file surface (workspace.readFile over the SAME composite VFS).
    const workspace = rt.executionRouter?.getProvider('workspace');
    if (!workspace) throw new Error('expected the workspace executor');
    const readBack = await workspace.tools.readFile.execute(snapshot.transcriptRelativePath);
    expect(String(readBack)).toContain('output-0 ');
    expect(String(readBack)).toContain('Task 0: please run step 0');

    // ── Ledger ordering: reset fired BEFORE the weave, so exactly ONE fresh
    // block exists and it sits at the compacted tail (a stale frozen block
    // would have woven mid-prompt as a second ephemeral message).
    expect(ledger.size).toBe(1);
    const plannedBlocks = ephemeralBlocks(plannedPrompt);
    expect(plannedBlocks).toHaveLength(1);
    expect(plannedBlocks[0]).toBe(plannedPrompt.length - 1);

    // ── Turn 2: identical history → deterministic cache-warm replay. No new
    // summaries, no reset, byte-identical model-visible context.
    const callsAfterPlan = summarizeCalls;
    await drive(overflowing);
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed']);
    expect(summarizeCalls).toBe(callsAfterPlan);
    expect(ledger.size).toBe(1);
    expect(JSON.stringify(prompts[2])).toBe(JSON.stringify(prompts[1]));
  });
});
