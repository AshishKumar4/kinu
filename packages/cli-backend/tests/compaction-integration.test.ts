/**
 * Default compaction end-to-end over the real shared storage plane, with better-compact wired as LocalAgentSession
 * and the DO's beforeTurn wire it: rewrite, lossless recall, durable replay, ledger reset ordering, archive manifest.
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { stepCountIs, type LanguageModel, type ModelMessage } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  DynamicContextLedger,
  ExtensionHost,
  initWorkspaceSchema,
  runChat,
  type ChatOptions,
} from '@kinu.run/core';
import {
  createCompactionExtension,
  createCompactionStateStore,
  createVfsTranscriptStore,
  type CompactionOutcomeEvent,
  type Logger,
} from '@kinu.run/compaction';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { scratchPath } from '@kinu.run/test-utils';
import * as v from 'valibot';

const SESSION = 'kinu-itest:default';

const silentLogger: Logger = { info() {}, debug() {}, warn() {}, error() {} };

function exchange(i: number, outputChars: number): ModelMessage[] {
  const id = `call_${i}`;

  return [
    { role: 'user', content: `Task ${i}: please run step ${i} of the plan.` },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Running step ${i} now.` },
        { type: 'tool-call', toolCallId: id, toolName: 'shell', input: { command: `step-${i}.sh` } },
      ],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: id, toolName: 'shell',
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

  for (const [i, m] of prompt.entries()) {
    if (m.role === 'user' && messageText(m).startsWith('<dynamic_context fingerprint="')) indices.push(i);
  }

  return indices;
}

describe('default compaction over the real storage plane', () => {
  test('rewrite → VFS transcript read-back → durable replay → ledger reset on non-replay', async () => {
    const db = new Database(scratchPath('compaction-integration', 'agent.db'), { create: true });

    const rt = createCLIRuntime(db, {
      dbPath: db.filename,
      llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' },
    });

    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const state = createCompactionStateStore(rt.storage.sql, rt.actor);
    const ledger = new DynamicContextLedger();
    const outcomes: CompactionOutcomeEvent[] = [];
    let summarizeCalls = 0;

    // Wired as both backends wire it: shared stores, model-transport summarize, non-replayed ledger reset.
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
        stopWhen: stepCountIs(1),
        extensions: new ExtensionHost().register(extension),
        cache: { sessionKey: SESSION },
      };

      if (transformTrigger) options.transformTrigger = transformTrigger;

      for await (const _ of runChat(options)) { /* drain */ }
    };

    const driveForced = (messages: ModelMessage[]) =>
      drive(messages, state.takeForceCompaction(SESSION) ? 'force' : undefined);

    const small = history(2, 100);
    await drive(small);
    expect(outcomes).toHaveLength(0);
    expect(ledger.size).toBe(1);
    expect(ephemeralBlocks(prompts[0] ?? [])).toHaveLength(1);

    const overflowing = history(15, 3_000); // ~45k chars ≈ 11k tokens > 8.5k trigger
    await drive(overflowing);
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned']);

    const plannedPrompt = prompts[1] ?? [];
    const plannedJson = JSON.stringify(plannedPrompt);
    expect(plannedJson.length).toBeLessThan(JSON.stringify(overflowing).length * 0.5);

    // Tool results ride as tool-result parts, so assert over the serialized prompt.
    expect(plannedJson).toContain('Task 14: please run step 14');
    expect(plannedJson).toContain('output-14 ');
    expect(plannedJson).not.toContain('output-0 ');

    const snapshot = await state.plans.load(SESSION);

    if (!snapshot) throw new Error('expected a persisted plan snapshot');
    expect(snapshot.transcriptRelativePath).toStartWith('.kinu/compaction/');
    expect(plannedJson).toContain(snapshot.transcriptRelativePath);

    const rows = rt.storage.sql<{ plan_json: string }>`
      SELECT plan_json FROM compaction_state WHERE session_key = ${SESSION}`;

    expect(rows).toHaveLength(1);

    const workspace = rt.executionRouter?.getProvider('workspace');

    if (!workspace) throw new Error('expected the workspace executor');
    const readBack = v.parse(v.string(), await workspace.tools.readFile.execute(snapshot.transcriptRelativePath));

    expect(readBack).toContain('output-0 ');
    expect(readBack).toContain('Task 0: please run step 0');

    // Reset fires before the weave, so exactly one fresh block sits at the compacted tail.
    expect(ledger.size).toBe(1);
    const plannedBlocks = ephemeralBlocks(plannedPrompt);
    expect(plannedBlocks).toHaveLength(1);
    expect(plannedBlocks[0]).toBe(plannedPrompt.length - 1);

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

    // Turn 2: identical history replays byte-identically, manifest included, with no new summaries.
    const callsAfterPlan = summarizeCalls;
    await drive(overflowing);
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed']);
    expect(summarizeCalls).toBe(callsAfterPlan);
    expect(ledger.size).toBe(1);
    expect(JSON.stringify(prompts[2])).toBe(JSON.stringify(prompts[1]));
    expect(state.archive.list(SESSION)).toHaveLength(1);

    // Turn 3: `agent.compactNow` only arms the one-shot force flag; turn assembly consumes it and folds early.
    const grown = [...overflowing, ...history(8, 3_000)];
    state.armForceCompaction(SESSION);
    await driveForced(grown);
    expect(outcomes.at(-1)?.outcome).toBe('planned');
    expect(state.takeForceCompaction(SESSION)).toBe(false);

    const ranges = state.archive.list(SESSION);
    expect(ranges).toHaveLength(2);
    expect(ranges[1].startTurn).toBe(ranges[0].endTurn + 1);
    expect(ranges[1].path).not.toBe(ranges[0].path);
    const foldedJson = JSON.stringify(prompts.at(-1));
    expect(foldedJson).toContain(`- turns 1-${ranges[0].endTurn} `);
    expect(foldedJson).toContain(`- turns ${ranges[1].startTurn}-${ranges[1].endTurn} `);
    expect(foldedJson).toContain(ranges[1].path);

    // Turn 4: refolding with nothing new rebuilds the same range; the index stays idempotent.
    state.armForceCompaction(SESSION);
    await driveForced(grown);
    expect(state.archive.list(SESSION)).toEqual(ranges);
    expect(JSON.stringify(prompts.at(-1))).toBe(foldedJson);
  });

  test('the first rung: superseded ephemeral blocks survive every unpressured turn and go first under pressure', async () => {
    const db = new Database(scratchPath('compaction-integration-rung', 'agent.db'), { create: true });

    const rt = createCLIRuntime(db, {
      dbPath: db.filename,
      llm: { name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model' },
    });

    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const state = createCompactionStateStore(rt.storage.sql, rt.actor);
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
        stopWhen: stepCountIs(1),
        extensions: new ExtensionHost().register(extension),
        cache: { sessionKey: SESSION },
      };

      if (providerReportedTokens !== undefined) options.providerReportedTokens = providerReportedTokens;

      for await (const _ of runChat(options)) { /* drain */ }
    })();

    /** Everything the provider is charged for, minus rolling cache markers that move to the tail (unit-volatile-context.test.ts). */
    const cacheableBytes = (m: PromptMessage) => JSON.stringify({ role: m.role, content: m.content });

    for (let turn = 0; turn < 3; turn++) {
      facts = `- fact ${turn}: ${'v'.repeat(4_000)}`;
      messages.push({ role: 'user', content: `turn ${turn}` }, { role: 'assistant', content: 'ok' });
      await drive();
    }

    expect(outcomes).toHaveLength(0);
    expect(ledger.size).toBe(3);
    expect(ephemeralBlocks(prompts[2] ?? [])).toHaveLength(3);

    // Cache-prefix invariant: each request repeats the last one's messages verbatim and only appends.
    const bytes = prompts.map((p) => p.map(cacheableBytes));

    for (let i = 1; i < bytes.length; i++) {
      expect(bytes[i].slice(0, bytes[i - 1].length)).toEqual(bytes[i - 1]);
      expect(bytes[i].length).toBeGreaterThan(bytes[i - 1].length);
    }

    // Pressure turn: the rung drops the superseded blocks and lands under the trigger with no summary (the summarizer throws).
    const beforePressure = prompts.length;
    messages.push({ role: 'user', content: 'turn 3' }, { role: 'assistant', content: 'ok' });
    await drive(8_600);

    expect(outcomes).toHaveLength(0);
    expect(ledger.size).toBe(1);
    const relieved = prompts[beforePressure] ?? [];
    const remaining = ephemeralBlocks(relieved);
    expect(remaining).toHaveLength(1);
    // The newest block survives at the frozen position it was born at.
    expect(messageText(relieved[remaining[0]])).toContain('- fact 2:');
    expect(remaining[0]).toBeLessThan(relieved.length - 1);
    // This request is cheaper than the previous one, which no append-only weave can be.
    expect(JSON.stringify(relieved).length)
      .toBeLessThan(JSON.stringify(prompts[beforePressure - 1]).length);

    facts = `- fact 3: ${'v'.repeat(4_000)}`;
    messages.push({ role: 'user', content: 'turn 4' }, { role: 'assistant', content: 'ok' });
    await drive();
    expect(ledger.size).toBe(2);
    const after = prompts.at(-1) ?? [];
    expect(ephemeralBlocks(after)).toHaveLength(2);
    expect(messageText(after[after.length - 1])).toContain('- fact 3:');
  });
});
