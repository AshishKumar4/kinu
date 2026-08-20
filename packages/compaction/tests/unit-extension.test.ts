/** Extension behavior through the public transformContext seam: trigger
 *  gating, plan build + transcript + reference message, cache-warm replay
 *  determinism, rangeHash refusal on an edited prefix, force rebuilds,
 *  summary upgrades (assistant runs + tuned prefix handoff), and fail-open
 *  summarizer degradation. */

import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { CONTEXT_CHECKPOINT_PREFIX, type TransformContext } from '@kinu/core';
import {
  createCompactionExtension,
  kinuCodec,
  type CompactionExtensionDeps,
  type CompactionOutcomeEvent,
  type CompactionProfile,
} from '../src/index';
import {
  assistant, history, memoryArchive, memoryPorts, toolCall, toolMessage, toolResult, user,
  validSummary, type MemoryArchiveStore, type MemoryPorts,
} from './helpers';

const SESSION = 'agent-test-session';

/** Small window + tiny recent-tool budget so modest fixtures overflow. */
const profile: CompactionProfile = {
  preset: 'custom',
  triggerPercent: 85,
  targetPercent: 30,
  recentToolTokens: 2_000,
  summarizerConcurrency: 2,
};

/** The ephemeral plane the ladder's first rung prunes, holding
 *  `supersededTokens` worth of superseded blocks. A second drop frees nothing,
 *  exactly as the real ledger's does. */
function fakeEphemeral(supersededTokens = 0) {
  let remaining = supersededTokens;
  const drops: number[] = [];
  return {
    drops,
    /** More superseded blocks piled up since the last drop. */
    refill(tokens: number) { remaining = tokens; },
    dropSuperseded(): number {
      const freed = remaining;
      remaining = 0;
      drops.push(freed);
      return freed;
    },
  };
}

interface Rig {
  ports: MemoryPorts;
  archive: MemoryArchiveStore;
  prompts: string[];
  outcomes: CompactionOutcomeEvent[];
  ephemeral: ReturnType<typeof fakeEphemeral>;
  transform: (messages: ModelMessage[], overrides?: Partial<TransformContext>) => Promise<ModelMessage[] | undefined>;
}

type RigOverrides = Omit<Partial<CompactionExtensionDeps>, 'ephemeral'> & {
  ephemeral?: ReturnType<typeof fakeEphemeral>;
};

function rig(overrides: RigOverrides = {}): Rig {
  const ports = memoryPorts();
  const archive = memoryArchive();
  const prompts: string[] = [];
  const outcomes: CompactionOutcomeEvent[] = [];
  const ephemeral = fakeEphemeral();
  const extension = createCompactionExtension({
    ports,
    archive,
    summarize: async (prompt) => {
      prompts.push(prompt);
      return validSummary(String(prompts.length));
    },
    ephemeral,
    profile,
    onOutcome: (event) => outcomes.push(event),
    ...overrides,
  });
  const transform = (messages: ModelMessage[], ctxOverrides: Partial<TransformContext> = {}) => {
    if (!extension.transformContext) throw new Error('extension must implement transformContext');
    return extension.transformContext({
      sessionKey: SESSION,
      messages,
      system: 'system prompt',
      contextWindow: 10_000,
      trigger: 'auto',
      ...ctxOverrides,
    });
  };
  return {
    ports, archive, prompts, outcomes, transform,
    ephemeral: overrides.ephemeral ?? ephemeral,
  };
}

describe('trigger gating', () => {
  test('under-threshold history is unchanged and persists nothing', async () => {
    const { ports, outcomes, transform } = rig();
    const result = await transform(history(3, 200));
    expect(result).toBeUndefined();
    expect(ports.plans.snapshots.size).toBe(0);
    expect(ports.transcripts.writes.size).toBe(0);
    expect(outcomes).toHaveLength(0);
  });

  test('provider-reported tokens are a trigger signal even when the estimate is low', async () => {
    const { transform, outcomes } = rig();
    const result = await transform(history(6, 200), { providerReportedTokens: 9_500 });
    expect(result).toBeDefined();
    expect(outcomes[0]?.outcome).toBe('planned');
  });

  test('empty history and zero window are benign', async () => {
    const { transform } = rig();
    expect(await transform([])).toBeUndefined();
    expect(await transform(history(2, 100), { contextWindow: 0 })).toBeUndefined();
  });

  test('the system prompt floors the estimate when no provider total exists yet', async () => {
    // history(6, 4000) estimates ~6.3k tokens against the 8.5k trigger — under
    // on its own, but the assembled system prompt rides every request unseen
    // by the message estimate. A ~12k-char system (~3k tokens) must push the
    // trigger decision over the line; a small one must not.
    const messages = history(6, 4_000);
    const small = rig();
    expect(await small.transform(messages)).toBeUndefined();
    expect(small.outcomes).toHaveLength(0);

    const large = rig();
    const result = await large.transform(messages, { system: 'S'.repeat(12_000) });
    expect(result).toBeDefined();
    expect(large.outcomes[0]?.outcome).toBe('planned');
  });
});

describe('the first rung — superseded ephemeral context', () => {
  test('nothing is pruned below the trigger: the ordinary path never touches the plane', async () => {
    const { transform, ephemeral, outcomes } = rig({ ephemeral: fakeEphemeral(5_000) });
    // Repeated turns well under the trigger, each a fresh transform — a
    // speculative rung would have fired on any of them.
    for (let i = 0; i < 3; i++) {
      expect(await transform(history(3, 200), { providerReportedTokens: 8_499 })).toBeUndefined();
    }
    expect(ephemeral.drops).toEqual([]);
    expect(outcomes).toHaveLength(0);
  });

  test('at the trigger the superseded blocks go FIRST, and what they free can stand the rest of the ladder down', async () => {
    // 8_600 is over the 8_500 trigger; dropping 500 tokens of superseded
    // blocks puts the request back under it, so no tool output is touched and
    // no plan is built — the cheapest rung was the only one needed.
    const { transform, ephemeral, ports, outcomes } = rig({ ephemeral: fakeEphemeral(500) });
    expect(await transform(history(3, 200), { providerReportedTokens: 8_600 })).toBeUndefined();
    expect(ephemeral.drops).toEqual([500]);
    expect(ports.plans.snapshots.size).toBe(0);
    expect(ports.transcripts.writes.size).toBe(0);
    expect(outcomes).toHaveLength(0);
  });

  test('when the first rung is not enough the stages below still run', async () => {
    const { transform, ephemeral, outcomes } = rig({ ephemeral: fakeEphemeral(200) });
    const result = await transform(history(15, 3_000), { providerReportedTokens: 20_000 });
    expect(ephemeral.drops).toEqual([200]);
    expect(result).toBeDefined();
    expect(outcomes[0]?.outcome).toBe('planned');
  });

  test('the freed tokens come off the provider total, never below the history floor', async () => {
    // A relief larger than the whole context cannot pretend the history is
    // free: the estimate + system floor still decides, so the ladder runs.
    const { transform, ephemeral, outcomes } = rig({ ephemeral: fakeEphemeral(1_000_000) });
    const result = await transform(history(15, 3_000), { providerReportedTokens: 20_000 });
    expect(ephemeral.drops).toEqual([1_000_000]);
    expect(result).toBeDefined();
    expect(outcomes[0]?.outcome).toBe('planned');
  });

  test('a REPLAYING plan still gets the rung — the case nothing else can relieve', async () => {
    // The engine's regrowth guard prices the prefix with the overhead recorded
    // when the plan was built, so ephemeral blocks appended after that are
    // invisible to it: the plan replays happily while the real request climbs.
    // Without this rung the plane would grow for the life of the activation.
    const ephemeral = fakeEphemeral(1_500);
    const { transform, outcomes } = rig({ ephemeral });
    const messages = history(15, 3_000);
    await transform(messages);
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned']);
    expect(ephemeral.drops).toEqual([1_500]);

    // Blocks appended since, then the same history again: the plan replays
    // byte-stably AND the rung still fires, because the provider is reporting
    // pressure the regrowth guard structurally cannot see.
    ephemeral.refill(2_000);
    expect(await transform(messages, { providerReportedTokens: 9_000 })).toBeDefined();
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed']);
    expect(ephemeral.drops).toEqual([1_500, 2_000]);
  });

  test('force prunes the plane too — the strongest pressure signal there is', async () => {
    const { transform, ephemeral } = rig({ ephemeral: fakeEphemeral(300) });
    await transform(history(6, 200), { trigger: 'force' });
    expect(ephemeral.drops).toEqual([300]);
  });
});

describe('plan build', () => {
  test('overflow prunes old tool output, protects the tail, injects the citable reference, writes the transcript', async () => {
    const { ports, outcomes, transform } = rig();
    const messages = history(15, 3_000); // ~45k chars of tool output ≈ 11k tokens > 8.5k trigger
    const result = await transform(messages);
    expect(result).toBeDefined();
    if (!result) throw new Error('expected a rewrite');

    // Shrunk for real, on the codec's own scale.
    const before = kinuCodec.estimateTurns(kinuCodec.encode(messages));
    const after = kinuCodec.estimateTurns(kinuCodec.encode(result));
    expect(after).toBeLessThan(before * 0.5);

    // The raw tail (from the 2nd-from-last user turn) is byte-verbatim.
    const tail = messages.slice(-6);
    for (let i = 0; i < 6; i++) expect(result[result.length - 6 + i]).toBe(tail[i]);

    // A reference message cites the transcript path the plan persisted.
    const snapshot = ports.plans.snapshots.get(SESSION);
    if (!snapshot) throw new Error('expected a persisted plan snapshot');
    const reference = result.find(
      (m) => m.role === 'user' && isString(m.content) && m.content.includes(snapshot.transcriptRelativePath),
    );
    expect(reference).toBeDefined();

    // Transcript holds the raw pruned output for read-back.
    const transcript = ports.transcripts.writes.get(snapshot.transcriptRelativePath);
    expect(transcript).toBeDefined();
    expect(transcript).toContain('output-0');

    expect(outcomes.map((o) => o.outcome)).toEqual(['planned']);
    expect(outcomes[0].plan?.rangeHash).toBe(snapshot.rangeHash);
  });

  test('early tool outputs are pruned while the recent-budget tool tail survives', async () => {
    const { transform } = rig();
    const messages = history(15, 3_000);
    const result = await transform(messages);
    if (!result) throw new Error('expected a rewrite');
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('output-0 ');
    expect(flat).toContain('output-14 ');
  });

  test('skills bodies are pruned even inside the recent tool budget', async () => {
    const { transform } = rig();
    const skillsBody = 'skill body '.repeat(30);
    const messages: ModelMessage[] = [
      ...history(14, 3_000),
      user('load the deploy skill'),
      assistant([toolCall('sk1', 'skills', { action: 'read', name: 'deploy' })]),
      toolMessage([toolResult('sk1', 'skills', skillsBody)]),
      ...history(2, 100).map((m) => m), // protected tail turns
    ];
    const result = await transform(messages);
    if (!result) throw new Error('expected a rewrite');
    expect(JSON.stringify(result)).not.toContain('skill body ');
  });
});

describe('replay', () => {
  test('same input replays deterministically without a rebuild', async () => {
    const { ports, outcomes, transform } = rig();
    const messages = history(15, 3_000);
    const first = await transform(messages);
    const second = await transform(messages);
    const third = await transform(messages);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed', 'replayed']);
    expect(ports.transcripts.writes.size).toBe(1);
    expect(ports.plans.snapshots.size).toBe(1);
  });

  test('appended tail growth under the trigger still replays the same prefix', async () => {
    const { outcomes, transform } = rig();
    const messages = history(15, 3_000);
    const first = await transform(messages);
    if (!first) throw new Error('expected a rewrite');
    const grown = [...messages, user('one more small question'), assistant([{ type: 'text', text: 'answer' }])];
    const second = await transform(grown);
    if (!second) throw new Error('expected a rewrite');
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed']);
    // Same transformed prefix, new tail appended.
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(second).toHaveLength(first.length + 2);
  });

  test('an edited prefix fails the rangeHash guard and rebuilds', async () => {
    const { ports, outcomes, transform } = rig();
    const messages = history(15, 3_000);
    await transform(messages);
    const firstHash = ports.plans.snapshots.get(SESSION)?.rangeHash;
    const edited = [...messages];
    edited[0] = user('REWRITTEN first task with different wording');
    const result = await transform(edited);
    expect(result).toBeDefined();
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'planned']);
    expect(ports.plans.snapshots.get(SESSION)?.rangeHash).not.toBe(firstHash);
  });

  test('a history rewrite that lands UNDER the trigger fires invalidated and clears the plan', async () => {
    const { ports, outcomes, transform } = rig();
    await transform(history(15, 3_000)); // planned
    // The conversation was rewritten to something small (undo / restart
    // truncation): the cached plan cannot replay and nothing replaces it —
    // the durable view flips back to raw, and listeners must hear about it.
    const rewritten = history(4, 100);
    const result = await transform(rewritten);
    expect(result).toBeUndefined();
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'invalidated']);
    expect(ports.plans.snapshots.size).toBe(0);
  });

  test('a plan persisted for another session never applies', async () => {
    const { ports, transform } = rig();
    const messages = history(15, 3_000);
    await transform(messages);
    const snapshot = ports.plans.snapshots.get(SESSION);
    if (!snapshot) throw new Error('expected snapshot');
    // A foreign snapshot (sessionId=agent-test-session) under another key is
    // ignored by the ownership check; a fresh plan is built and saved.
    ports.plans.snapshots.set('other-session', snapshot);
    const ext = createCompactionExtension({
      ports, archive: memoryArchive(), summarize: async () => validSummary('other'),
      ephemeral: fakeEphemeral(), profile,
    });
    const result = await ext.transformContext?.({
      sessionKey: 'other-session',
      messages,
      system: 's',
      contextWindow: 10_000,
      trigger: 'auto',
    });
    expect(result).toBeDefined();
    expect(ports.plans.snapshots.get('other-session')?.sessionId).toBe('other-session');
  });

  test('a JSON-round-tripped snapshot (durable plan store) still replays', async () => {
    const { ports, outcomes, transform } = rig();
    const messages = history(15, 3_000);
    const first = await transform(messages);
    const snapshot = ports.plans.snapshots.get(SESSION);
    if (!snapshot) throw new Error('expected snapshot');
    ports.plans.snapshots.set(SESSION, JSON.parse(JSON.stringify(snapshot)));
    const second = await transform(messages);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed']);
  });
});

describe('force trigger', () => {
  test('force rebuilds below the trigger threshold', async () => {
    const { outcomes, transform } = rig();
    const messages = history(6, 500); // well under trigger
    expect(await transform(messages)).toBeUndefined();
    const forced = await transform(messages, { trigger: 'force' });
    expect(forced).toBeDefined();
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned']);
  });

  test('force with an existing plan rebuilds rather than replaying', async () => {
    const { outcomes, transform, ports } = rig();
    const messages = history(15, 3_000);
    await transform(messages);
    const firstSnapshot = ports.plans.snapshots.get(SESSION);
    const forced = await transform(messages, { trigger: 'force' });
    expect(forced).toBeDefined();
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'planned']);
    // The rebuild honors the prior plan as its floor (same range, same transcript path).
    expect(ports.plans.snapshots.get(SESSION)?.transcriptRelativePath).toBe(firstSnapshot?.transcriptRelativePath);
  });

  test('force on a too-small history is benign', async () => {
    const { transform } = rig();
    expect(await transform([user('only message')], { trigger: 'force' })).toBeUndefined();
  });
});

describe('archive manifest', () => {
  /** Fat USER turns: no prune stage touches them, so the ladder falls through
   *  to the checkpoint — the message the manifest must ride on. */
  const fatUser = (i: number): ModelMessage[] => [
    user(`requirement ${i}: ${'detail '.repeat(1_000)}`),
    assistant([{ type: 'text', text: `noted ${i}` }]),
  ];
  const fatHistory = (turns: number): ModelMessage[] =>
    Array.from({ length: turns }, (_, i) => fatUser(i)).flat();

  test('the checkpoint message carries a manifest line for the archived range', async () => {
    const { archive, ports, transform } = rig();
    const result = await transform(fatHistory(8));
    if (!result) throw new Error('expected a rewrite');
    const snapshot = ports.plans.snapshots.get(SESSION);
    if (!snapshot) throw new Error('expected a persisted plan snapshot');

    const ranges = archive.list(SESSION);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      rangeHash: snapshot.rangeHash,
      path: snapshot.transcriptRelativePath,
      startTurn: 1,
      endTurn: 12,
      userTurns: 6,
      assistantTurns: 6,
    });
    expect(ranges[0].firstUserAsk).toStartWith('requirement 0:');

    // Same message as the checkpoint — the manifest is navigation FOR it.
    const checkpoint = result.find(
      (m) => isString(m.content) && m.content.includes('[Context Summary]'),
    );
    expect(checkpoint?.content).toInclude('## Compaction Archive');
    expect(checkpoint?.content).toInclude(
      '- turns 1-12 (6 user / 6 assistant) — "requirement 0: detail detail',
    );
    expect(checkpoint?.content).toInclude(snapshot.transcriptRelativePath);
  });

  test('a replayed plan indexes nothing more and re-renders byte-identically', async () => {
    const { archive, transform } = rig();
    const messages = fatHistory(8);
    const first = await transform(messages);
    const second = await transform(messages);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(archive.list(SESSION)).toHaveLength(1);
  });

  test('an advanced boundary indexes only the delta and lists both ranges', async () => {
    const { archive, transform } = rig();
    const messages = fatHistory(8);
    await transform(messages);
    const grown = [...messages, ...fatUser(8), ...fatUser(9), ...fatUser(10)];
    const result = await transform(grown);
    if (!result) throw new Error('expected a rebuild');

    const ranges = archive.list(SESSION);
    expect(ranges).toHaveLength(2);
    expect(ranges[1]).toMatchObject({ startTurn: 13, endTurn: 18, userTurns: 3, assistantTurns: 3 });
    expect(ranges[1].firstUserAsk).toStartWith('requirement 6:');
    expect(ranges[1].path).not.toBe(ranges[0].path);
    const checkpoint = result.find(
      (m) => isString(m.content) && m.content.includes('## Compaction Archive'),
    );
    expect(checkpoint?.content).toInclude('- turns 1-12 ');
    expect(checkpoint?.content).toInclude('- turns 13-18 ');
  });

  test('an edited prefix restarts the index instead of stacking a stale range', async () => {
    const { archive, transform } = rig();
    const messages = fatHistory(8);
    await transform(messages);
    const edited = [...messages];
    edited[0] = user(`REWRITTEN requirement: ${'detail '.repeat(1_000)}`);
    await transform(edited);
    const ranges = archive.list(SESSION);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ startTurn: 1 });
    expect(ranges[0].firstUserAsk).toStartWith('REWRITTEN requirement:');
  });
});

describe('summaries', () => {
  test('assistant runs collapse through the injected summarizer with the per-run prompt', async () => {
    const { prompts, transform } = rig();
    // Fat assistant TEXT (not tool output): only the assistant-runs stage can shrink it.
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(user(`chapter ${i}?`));
      messages.push(assistant([{ type: 'text', text: `chapter ${i}: ${'prose '.repeat(1_200)}` }]));
    }
    const result = await transform(messages);
    if (!result) throw new Error('expected a rewrite');
    const runPrompts = prompts.filter((p) => p.includes('Summarize this historical assistant turn'));
    expect(runPrompts.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).toContain('Summary(');
  });

  test('an advanced boundary re-summarizes iteratively from the previous checkpoint', async () => {
    const { prompts, transform } = rig();
    const fatUser = (i: number): ModelMessage[] => [
      user(`requirement ${i}: ${'detail '.repeat(1_000)}`),
      assistant([{ type: 'text', text: `noted ${i}` }]),
    ];
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 8; i++) messages.push(...fatUser(i));
    await transform(messages); // first prefix-summary plan (checkpoint-wrapped)
    const promptsBeforeGrowth = prompts.length;

    const grown = [...messages, ...fatUser(8), ...fatUser(9), ...fatUser(10)];
    await transform(grown); // regrown past trigger → boundary advances → rebuild
    const growthPrompts = prompts.slice(promptsBeforeGrowth);
    const rollingPrompts = growthPrompts.filter((p) =>
      p.includes('Roll this prior prefix summary forward'),
    );
    expect(rollingPrompts).toHaveLength(1);
    expect(rollingPrompts[0]).toContain(validSummary('1'));
    expect(rollingPrompts[0]).toContain(CONTEXT_CHECKPOINT_PREFIX);
    expect(growthPrompts.some((p) => p.includes('PREVIOUS SUMMARY'))).toBe(false);
  });

  test('a rejected rolling summary does not bypass the scheduler for a second attempt', async () => {
    const summaryPrompts: string[] = [];
    const { transform } = rig({
      summarize: async (prompt) => {
        summaryPrompts.push(prompt);
        if (summaryPrompts.length === 1) return validSummary('initial');
        throw new Error('rolling summary unavailable');
      },
    });
    const fatUser = (i: number): ModelMessage[] => [
      user(`requirement ${i}: ${'detail '.repeat(1_000)}`),
      assistant([{ type: 'text', text: `noted ${i}` }]),
    ];
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 8; i++) messages.push(...fatUser(i));
    await transform(messages);

    await transform([...messages, ...fatUser(8), ...fatUser(9), ...fatUser(10)]);
    expect(summaryPrompts).toHaveLength(2);
    expect(summaryPrompts[1]).toContain('Roll this prior prefix summary forward');
    expect(summaryPrompts.some((prompt) => prompt.includes('PREVIOUS SUMMARY'))).toBe(false);
  });

  test('prefix fallback upgrades to the tuned handoff summary and stays sticky', async () => {
    const { ports, prompts, outcomes, transform } = rig();
    // Fat USER messages: no prune stage touches user turns, so the ladder
    // must fall through to the last-resort prefix summary.
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(user(`requirement ${i}: ${'detail '.repeat(1_000)}`));
      messages.push(assistant([{ type: 'text', text: `noted ${i}` }]));
    }
    const result = await transform(messages);
    if (!result) throw new Error('expected a rewrite');

    const prefixPrompts = prompts.filter((p) => p.includes('## Active Task'));
    expect(prefixPrompts).toHaveLength(1);
    // The tuned template got the verbatim latest ask and the transcript.
    expect(prefixPrompts[0]).toContain('requirement 7');
    expect(prefixPrompts[0]).toContain('structured handoff summary');

    const snapshot = ports.plans.snapshots.get(SESSION);
    expect(snapshot?.requiresCustomCompaction).toBe(true);
    expect(snapshot?.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)).toBe(true);
    expect(JSON.stringify(result)).toContain('[Context Summary]');

    // Replay keeps the upgraded summary without re-summarizing.
    const promptCount = prompts.length;
    const again = await transform(messages);
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
    expect(prompts.length).toBe(promptCount);
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned', 'replayed']);
  });

  test('a split first turn upgrades the exact compacted fragment', async () => {
    const { ports, prompts, transform } = rig();
    const result = await transform([{
      role: 'user',
      content: [
        { type: 'text', text: `old requirement ${'x'.repeat(72_000)}` },
        { type: 'text', text: 'newest requirement stays raw' },
      ],
    }]);
    expect(result).toBeDefined();
    expect(prompts.filter((prompt) => prompt.includes('## Active Task'))).toHaveLength(1);
    expect(ports.plans.snapshots.get(SESSION)?.rawTailItemBoundary).toBeDefined();
    expect(ports.plans.snapshots.get(SESSION)?.prefixSummary?.startsWith(CONTEXT_CHECKPOINT_PREFIX)).toBe(true);
  });

  test('a failing summarizer degrades to deterministic previews, never breaks the turn', async () => {
    const { transform, outcomes } = rig({
      summarize: async () => {
        throw new Error('llm down');
      },
    });
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(user(`requirement ${i}: ${'detail '.repeat(1_000)}`));
      messages.push(assistant([{ type: 'text', text: `noted ${i}` }]));
    }
    const result = await transform(messages);
    expect(result).toBeDefined();
    expect(outcomes.map((o) => o.outcome)).toEqual(['planned']);
    // Deterministic structured fallback, not the LLM one.
    expect(JSON.stringify(result)).toContain('[Context Summary]');
    expect(JSON.stringify(result)).not.toContain('Summary(');
  });

  test('too-short summaries are discarded in favor of previews', async () => {
    const { transform } = rig({ summarize: async () => 'too short' });
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(user(`chapter ${i}?`));
      messages.push(assistant([{ type: 'text', text: `chapter ${i}: ${'prose '.repeat(1_200)}` }]));
    }
    const result = await transform(messages);
    if (!result) throw new Error('expected a rewrite');
    expect(JSON.stringify(result)).not.toContain('too short');
    // Collapsed runs fall back to truncated previews of the original text.
    expect(JSON.stringify(result)).toContain('[Assistant turn summary]');
  });
});

function isString<Value>(value: Value): value is Value & string {
  return v.is(v.string(), value);
}
