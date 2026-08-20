/**
 * The default compaction path end-to-end over the REAL storage plane both
 * backends share: an overflowing history driven through runChat with the
 * better-compact extension wired exactly as LocalAgentSession (and the DO's
 * beforeTurn) wires it — the real workspace filesystem in agent.db, real
 * compaction_state rows, a real DynamicContextLedger.
 *
 * Proves the four 2B guarantees:
 *  1. the transform rewrites the model-visible history (fewer tokens, tail
 *     protected byte-verbatim, citable reference message present);
 *  2. the raw transcript is written into the workspace VFS AND reads back
 *     through the agent's own file surface (workspace.readFile) — the
 *     lossless-recall round-trip;
 *  3. the plan persists durably and an identical next turn REPLAYS it
 *     byte-stably without re-summarizing;
 *  4. the ledger resets on every non-replayed outcome — before the weave —
 *     so the fresh block lands at the compacted tail, while replay keeps it
 *     frozen;
 *  5. every archived range is indexed durably and rendered into the checkpoint
 *     as the navigation manifest, and agent.compactNow's machinery (the
 *     one-shot force flag) folds a finished phase early — extending the
 *     manifest once, then idempotently.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel, ModelMessage } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  DynamicContextLedger,
  ExtensionHost,
  initWorkspaceSchema,
  runChat,
  type ChatOptions,
} from '@kinu/core';
import {
  createCompactionExtension,
  createCompactionStateStore,
  createVfsTranscriptStore,
  type CompactionOutcomeEvent,
  type Logger,
} from '@kinu/compaction';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { scratchPath } from '@kinu/test-utils';

const SESSION = 'kinu-itest:default';
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

type PromptMessage = LanguageModelV2CallOptions['prompt'][number];

interface CapturingModel {
  model: LanguageModel;
  prompts: PromptMessage[][];
}

/** One-step text model that records the exact prompt of every call. */
function capturingModel(): CapturingModel {
  const prompts: PromptMessage[][] = [];
  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => {
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
  });
  return { model, prompts };
}

function messageText(m: PromptMessage): string {
  if (m.role === 'system') return m.content;
  return m.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
}

function ephemeralBlocks(prompt: PromptMessage[]): number[] {
  const indices: number[] = [];
  prompt.forEach((m, i) => {
    if (m.role === 'user' && messageText(m).startsWith('<dynamic_context fingerprint="')) indices.push(i);
  });
  return indices;
}

describe('default compaction over the real storage plane', () => {
  test('rewrite → VFS transcript read-back → durable replay → ledger reset on non-replay', async () => {
    const db = new Database(':memory:');
    const rt = createCLIRuntime(db, {
      dbPath: scratchPath('compaction-integration', 'agent.db'),
      llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' },
    });

    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const state = createCompactionStateStore(rt.storage.sql);
    const ledger = new DynamicContextLedger();
    const outcomes: CompactionOutcomeEvent[] = [];
    let summarizeCalls = 0;
    // Wired EXACTLY as both backends wire it: shared stores + model-transport
    // summarize + the non-replayed ledger reset.
    const extension = createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => rt.storage.vfs),
        plans: state.plans,
        logger: silentLogger,
      },
      archive: state.archive,
      ephemeral: ledger,
      summarize: async () => {
        summarizeCalls++;
        return [
          '## Decisions',
          `- Summary(${summarizeCalls}): preserve the verified implementation decisions.`,
          '## Files & Symbols',
          '- packages/compaction/src/extension.ts',
          '## Errors (verbatim)',
          '- (none)',
          '## What failed and why',
          '- (none)',
          '## Constraints',
          '- Preserve exact IDs and paths.',
          '## Next step',
          '- Continue from the compacted checkpoint.',
        ].join('\n');
      },
      onOutcome: (event) => {
        outcomes.push(event);
        if (event.outcome !== 'replayed') ledger.reset();
      },
    });

    const { model, prompts } = capturingModel();
    const drive = async (messages: ModelMessage[], transformTrigger?: 'force') => {
      const options: ChatOptions = {
        model,
        modelContext: { id: 'fake/fake-model', contextWindow: 10_000 },
        system: 'system prompt',
        history: messages,
        dynamicContext: { ledger, snapshot: () => ({ factsBlock: '- the user prefers TypeScript' }) },
        tools: {},
        maxSteps: 1,
        extensions: new ExtensionHost().register(extension),
        cache: { sessionKey: SESSION },
      };
      if (transformTrigger) options.transformTrigger = transformTrigger;
      for await (const _ of runChat(options)) { /* drain */ }
    };
    // What a turn assembly does with the armed one-shot flag.
    const driveForced = (messages: ModelMessage[]) =>
      drive(messages, state.takeForceCompaction(SESSION) ? 'force' : undefined);

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
    const snapshot = await state.plans.load(SESSION);
    if (!snapshot) throw new Error('expected a persisted plan snapshot');
    expect(snapshot.transcriptRelativePath.startsWith('.kinu/compaction/')).toBe(true);
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

    // ── Navigation manifest: the archived range is indexed durably and the
    // model-visible checkpoint carries its line, citing the same path that
    // just read back losslessly above.
    const indexed = state.archive.list(SESSION);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({
      rangeHash: snapshot.rangeHash,
      path: snapshot.transcriptRelativePath,
      startTurn: 1,
    });
    expect(indexed[0].firstUserAsk).toStartWith('Task 0: please run step 0');
    expect(plannedJson).toContain('## Compaction Archive');
    expect(plannedJson).toContain(`- turns 1-${indexed[0].endTurn} `);
    expect(rt.storage.sql`SELECT range_hash FROM compaction_archive WHERE session_key = ${SESSION}`)
      .toHaveLength(1);

    // ── Turn 2: identical history → deterministic cache-warm replay. No new
    // summaries, no reset, byte-identical model-visible context — including
    // the manifest, which only moves when a new range is archived.
    const callsAfterPlan = summarizeCalls;
    await drive(overflowing);
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed']);
    expect(summarizeCalls).toBe(callsAfterPlan);
    expect(ledger.size).toBe(1);
    expect(JSON.stringify(prompts[2])).toBe(JSON.stringify(prompts[1]));
    expect(state.archive.list(SESSION)).toHaveLength(1);

    // ── Turn 3: agent.compactNow at a phase boundary. Arming the one-shot
    // force flag is all the tool does; the turn assembly consumes it and the
    // ladder folds the finished phase EARLY, without waiting for the trigger.
    const grown = [...overflowing, ...history(8, 3_000)];
    state.armForceCompaction(SESSION);
    await driveForced(grown);
    expect(outcomes.at(-1)?.outcome).toBe('planned');
    // Consumed exactly once — a repeat assembly can never loop the ladder.
    expect(state.takeForceCompaction(SESSION)).toBe(false);

    // The second archived range indexes only what the fold ADDED.
    const ranges = state.archive.list(SESSION);
    expect(ranges).toHaveLength(2);
    expect(ranges[1].startTurn).toBe(ranges[0].endTurn + 1);
    expect(ranges[1].path).not.toBe(ranges[0].path);
    const foldedJson = JSON.stringify(prompts.at(-1));
    expect(foldedJson).toContain(`- turns 1-${ranges[0].endTurn} `);
    expect(foldedJson).toContain(`- turns ${ranges[1].startTurn}-${ranges[1].endTurn} `);
    expect(foldedJson).toContain(ranges[1].path);

    // ── Turn 4: folding again with nothing new to fold rebuilds over the SAME
    // range, so the index is idempotent — no phantom entry, no duplicate line.
    state.armForceCompaction(SESSION);
    await driveForced(grown);
    expect(state.archive.list(SESSION)).toEqual(ranges);
    expect(JSON.stringify(prompts.at(-1))).toBe(foldedJson);
  });

  test('the first rung: superseded ephemeral blocks survive every unpressured turn and go first under pressure', async () => {
    const db = new Database(':memory:');
    const rt = createCLIRuntime(db, {
      dbPath: scratchPath('compaction-integration-rung', 'agent.db'),
      llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' },
    });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const state = createCompactionStateStore(rt.storage.sql);
    const ledger = new DynamicContextLedger();
    const outcomes: CompactionOutcomeEvent[] = [];
    const extension = createCompactionExtension({
      ports: {
        transcripts: createVfsTranscriptStore(() => rt.storage.vfs),
        plans: state.plans,
        logger: silentLogger,
      },
      archive: state.archive,
      ephemeral: ledger,
      summarize: async () => { throw new Error('no summary should be needed'); },
      onOutcome: (event) => {
        outcomes.push(event);
        if (event.outcome !== 'replayed') ledger.reset();
      },
    });

    const { model, prompts } = capturingModel();
    // Fat blocks so what the rung frees is decisive rather than marginal.
    let facts = '';
    const messages: ModelMessage[] = [];
    const drive = (providerReportedTokens?: number) => (async () => {
      const options: ChatOptions = {
        model,
        modelContext: { id: 'fake/fake-model', contextWindow: 10_000 },
        system: 'system prompt',
        history: messages,
        dynamicContext: { ledger, snapshot: () => ({ factsBlock: facts }) },
        tools: {},
        maxSteps: 1,
        extensions: new ExtensionHost().register(extension),
        cache: { sessionKey: SESSION },
      };
      if (providerReportedTokens !== undefined) options.providerReportedTokens = providerReportedTokens;
      for await (const _ of runChat(options)) { /* drain */ }
    })();

    /** Everything the provider is charged for, minus the rolling cache markers
     *  that move to the tail by design (unit-volatile-context.test.ts). */
    const cacheableBytes = (m: PromptMessage) => JSON.stringify({ role: m.role, content: m.content });

    // ── Three unpressured turns, each with different live state, so the
    // ledger accumulates three frozen blocks.
    for (let turn = 0; turn < 3; turn++) {
      facts = `- fact ${turn}: ${'v'.repeat(4_000)}`;
      messages.push({ role: 'user', content: `turn ${turn}` }, { role: 'assistant', content: 'ok' });
      await drive();
    }
    expect(outcomes).toHaveLength(0);          // the ladder never fired…
    expect(ledger.size).toBe(3);               // …so nothing was ever dropped.
    expect(ephemeralBlocks(prompts[2] ?? [])).toHaveLength(3);

    // The cache-prefix invariant on the wire: each request repeats the last
    // one's messages verbatim and only appends.
    const bytes = prompts.map((p) => p.map(cacheableBytes));
    for (let i = 1; i < bytes.length; i++) {
      expect(bytes[i]!.slice(0, bytes[i - 1]!.length)).toEqual(bytes[i - 1]!);
      expect(bytes[i]!.length).toBeGreaterThan(bytes[i - 1]!.length);
    }

    // ── The pressure turn: the provider reports 8_600 against an 8_500
    // trigger. The rung drops the two superseded blocks (~2k tokens) and the
    // request lands back under, so no tool output is touched, no plan is
    // built, and no summary is ever requested (the summarizer throws). Live
    // state is unchanged this turn, so nothing new is born either.
    const beforePressure = prompts.length;
    messages.push({ role: 'user', content: 'turn 3' }, { role: 'assistant', content: 'ok' });
    await drive(8_600);

    expect(outcomes).toHaveLength(0);
    expect(ledger.size).toBe(1);
    const relieved = prompts[beforePressure] ?? [];
    const remaining = ephemeralBlocks(relieved);
    expect(remaining).toHaveLength(1);
    // What survived is the NEWEST block — the live state the model reads —
    // still at the frozen position it was born at, not re-created at the tail.
    expect(messageText(relieved[remaining[0]!]!)).toContain('- fact 2:');
    expect(remaining[0]).toBeLessThan(relieved.length - 1);
    // The prefix break is real and is the point: this request is CHEAPER than
    // the one before it, which no append-only weave can ever be.
    expect(JSON.stringify(relieved).length)
      .toBeLessThan(JSON.stringify(prompts[beforePressure - 1]).length);

    // ── And the plane keeps working afterwards: new live state supersedes the
    // survivor at the tail exactly as before.
    facts = `- fact 3: ${'v'.repeat(4_000)}`;
    messages.push({ role: 'user', content: 'turn 4' }, { role: 'assistant', content: 'ok' });
    await drive();
    expect(ledger.size).toBe(2);
    const after = prompts.at(-1) ?? [];
    expect(ephemeralBlocks(after)).toHaveLength(2);
    expect(messageText(after[after.length - 1]!)).toContain('- fact 3:');
  });
});
